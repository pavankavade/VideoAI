import os
import time
import uuid
import math
import asyncio
from PIL import Image

def get_panel_scale(img_path):
    dw, dh = 540, 540
    try:
        with Image.open(img_path) as img:
            srcW, srcH = img.size
        panel_base_size = 540.0
        scale = panel_base_size / max(srcW, srcH)
        PANEL_BASE_SIZE = 1.2
        dstW, dstH = 1920, 1080
        scaledDstW = dstW * PANEL_BASE_SIZE
        scaledDstH = dstH * PANEL_BASE_SIZE
        
        srcAR = srcW / srcH
        scaledAR = scaledDstW / scaledDstH
        
        if srcAR > scaledAR:
            dw = scaledDstW
            dh = scaledDstW / srcAR
        else:
            dh = scaledDstH
            dw = scaledDstH * srcAR
            
        # Ensure even dimensions for FFmpeg
        dw = int(dw)
        dh = int(dh)
        dw = dw - (dw % 2)
        dh = dh - (dh % 2)
    except Exception as e:
        print(f"Warning: Could not compute panel size for {img_path}, using default. ({e})")
        
    return f"{max(2, dw)}:{max(2, dh)}"
import logging
from pathlib import Path
from typing import Optional, Dict, Any, Callable, List

logger = logging.getLogger("ffmpeg_renderer")

def check_ffmpeg():
    import shutil
    return shutil.which('ffmpeg') is not None

FFMPEG_AVAILABLE = check_ffmpeg()

class FFmpegRenderer:
    """
    Records video editor output natively using FFmpeg.
    Constructs a complex filtergraph to mimic canvas effects.
    """
    
    def __init__(self, output_dir: str = "renders"):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(exist_ok=True)
        
    async def get_audio_duration(self, audio_path: str) -> float:
        if not audio_path or not os.path.exists(audio_path):
            return 0.0
        
        try:
            proc = await asyncio.create_subprocess_exec(
                'ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                '-of', 'default=noprint_wrappers=1:nokey=1', audio_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            stdout, stderr = await proc.communicate()
            if proc.returncode == 0:
                return float(stdout.decode().strip())
        except Exception as e:
            logger.warning(f"Failed to get audio duration for {audio_path}: {e}")
        return 0.0

    async def record_project(
        self, 
        project_id: str, 
        duration: Optional[float] = None,
        width: int = 1920,
        height: int = 1080,
        fps: int = 30,
        audio_bitrate: str = "128k",
        video_bitrate: str = "5M",
        progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
        auto_generate_timeline: bool = False
    ) -> Dict[str, Any]:
        
        def report_progress(stage: str, detail: str = "", **kwargs):
            if progress_callback:
                event_data = {"stage": stage, "detail": detail, **kwargs}
                logger.info(f"[Progress] Sending: {stage} - {detail}")
                progress_callback(event_data)

        if not FFMPEG_AVAILABLE:
            return {
                "status": "error",
                "error": "FFmpeg not installed. Please install FFmpeg and ensure it's in your PATH."
            }
            
        start_time = time.time()
        job_id = uuid.uuid4().hex[:8]
        
        # 1. Fetch project data
        from mangaeditor import EditorDB
        project = EditorDB.get_project(project_id)
        if not project:
            return {"status": "error", "error": "Project not found"}
            
        chapter_prefix = ""
        ch_num = project.get("metadata", {}).get("chapter_number") or project.get("chapter_number")
        if ch_num is not None:
            try:
                if float(ch_num).is_integer():
                    ch_num = int(float(ch_num))
            except ValueError:
                pass
            chapter_prefix = f"ch{ch_num}_"

        output_filename = f"{chapter_prefix}ffmpeg-rendering-{project_id}-{job_id}.mp4"
        output_path = self.output_dir / output_filename
        
        report_progress("initializing", "Extracting project timeline...", elapsed=0, remaining=None)
        
        # Build timeline
        # Effect configs from videoeditor
        try:
            from videoeditor import EFFECT_MAX_DURATION, TRANSITION_DURATION, TRANSITION_OVERLAP
            max_dur = EFFECT_MAX_DURATION
            trans_dur = TRANSITION_DURATION
            trans_over = TRANSITION_OVERLAP
        except ImportError:
            max_dur = 5.0
            trans_dur = 0.8
            trans_over = 0.4

        # Read timeline from DB layers if present, else auto-generate
        layers = project.get("metadata", {}).get("layers", [])
        
        clips = []
        if layers and not auto_generate_timeline:
            # Reconstruct from layers
            # Note: Layers typically contain visual effects and audio paths.
            # But the simplest is to rebuild the timeline sequentially from panels
            pass
            
        # Rebuilding timeline sequentially from panels (simulating auto_generate_timeline logic)
        # This is more robust as it guarantees we have perfectly synced audio and video
        current_time = 0.0
        
        pages = project.get("pages", [])
        for page in pages:
            for panel in page.get("panels", []):
                img_path = panel.get("image_path")
                if img_path and img_path.startswith("/"):
                    img_path = img_path.lstrip("/")
                    # Resolve to absolute
                    if not os.path.isabs(img_path):
                        from mangaeditor import BASE_DIR
                        img_path = os.path.join(BASE_DIR, img_path)
                
                audio_path = panel.get("audio_path")
                if audio_path and audio_path.startswith("/"):
                    audio_path = audio_path.lstrip("/")
                    if not os.path.isabs(audio_path):
                        from mangaeditor import BASE_DIR
                        audio_path = os.path.join(BASE_DIR, audio_path)
                
                # Verify paths exist
                if not img_path or not os.path.exists(img_path):
                    continue
                    
                audio_dur = 0.0
                if audio_path and os.path.exists(audio_path):
                    audio_dur = await self.get_audio_duration(audio_path)
                    
                # Min duration logic
                clip_dur = max(audio_dur + 0.5, 2.0) # pad audio slightly or min 2.0s
                
                clips.append({
                    "image": img_path,
                    "audio": audio_path if audio_path and os.path.exists(audio_path) else None,
                    "duration": clip_dur,
                    "effect": panel.get("effect", "zoom_in"),
                    "transition": panel.get("transition", "slide_book"),
                    "audio_dur": audio_dur
                })

        if not clips:
            return {"status": "error", "error": "No valid panels/images found to render."}

        total_duration = 0.0
        for i, clip in enumerate(clips):
            total_duration += clip["duration"]
            if i > 0 and clip["transition"] not in ["none", ""]:
                total_duration -= trans_over # Overlap
                
        report_progress("duration_detected", f"Total timeline duration: {total_duration:.1f}s", elapsed=0, remaining=total_duration, total_duration=total_duration)

        report_progress("processing", "Generating FFmpeg chunks...", elapsed=time.time() - start_time, remaining=total_duration)
        
        try:
            import shlex
            import re
            
            MAX_CLIPS_PER_CHUNK = 30
            chunks = []
            curr_chunk = []
            for clip in clips:
                curr_chunk.append(clip)
                if len(curr_chunk) >= MAX_CLIPS_PER_CHUNK:
                    chunks.append(curr_chunk)
                    curr_chunk = []
            if curr_chunk:
                chunks.append(curr_chunk)
                
            chunk_files = [None] * len(chunks)
            bg_path = os.path.join(BASE_DIR, "static", "blur_glitch_background.png")
            
            async def render_chunk_func(chunk_idx, chunk_clips):
                trans_dur = 0.5
                trans_over = trans_dur  # overlap for transitions
                chunk_dur = 0
                
                for c in chunk_clips:
                    chunk_dur += c["duration"]
                    if c["transition"] not in ["none", ""]:
                        chunk_dur -= trans_over
                
                filter_script_path = self.output_dir / f"filter_{job_id}_{chunk_idx}.txt"
                chunk_output = self.output_dir / f"chunk_{job_id}_{chunk_idx}.mp4"
                
                inputs = []
                input_idx = 0
                
                # Single background for the whole chunk
                if bg_path and os.path.exists(bg_path):
                    inputs.append(f'-loop 1 -i "{bg_path}"')
                    bg_in_idx = input_idx
                    input_idx += 1
                else:
                    bg_in_idx = None
                    
                filter_lines = []
                video_streams = []
                audio_streams = []
                
                # Supersampling factor to eliminate zoompan jitter
                ss = 2
                panel_w, panel_h = 1344 * ss, 756 * ss
                panel_res = f"{panel_w}x{panel_h}"
                canvas_res = f"{1920 * ss}x{1080 * ss}"
                out_res = "1920x1080"
                
                for i, clip in enumerate(chunk_clips):
                    img_in_idx = input_idx
                    inputs.append(f'-i "{clip["image"]}"')
                    input_idx += 1
                    
                    if clip["audio"]:
                        inputs.append(f'-i "{clip["audio"]}"')
                        aud_in_idx = input_idx
                        input_idx += 1
                    else:
                        aud_in_idx = None
                        
                    frames = int(clip['duration']*24)
                    
                    # 1. Scale panel to 70% and pad to 1080p with transparent background
                    scale_to_box = f"scale={panel_res}:force_original_aspect_ratio=decrease"
                    pad_to_canvas = f"pad={canvas_res.replace('x', ':')}:(ow-iw)/2:(oh-ih)/2:color=black@0.0"
                    filter_lines.append(f"[{img_in_idx}:v]format=rgba,{scale_to_box},{pad_to_canvas}[padded{i}];")
                    
                    # 2. Zoompan the padded canvas (so the panel grows/shrinks naturally)
                    zoom_base = f"fps=24:s={out_res},setsar=1/1"
                    cx = "iw/2-(iw/zoom)/2"
                    cy = "ih/2-(ih/zoom)/2"
                    
                    if clip.get("effect") == "zoom_in":
                        filter_lines.append(f"[padded{i}]zoompan=z='min(1.0+0.0006*on,1.5)':x='{cx}':y='{cy}':d={frames}:{zoom_base}[v{i}];")
                    elif clip.get("effect") == "zoom_out":
                        filter_lines.append(f"[padded{i}]zoompan=z='max(1.15-0.0006*on,1.0)':x='{cx}':y='{cy}':d={frames}:{zoom_base}[v{i}];")
                    elif clip.get("effect") == "pan_right":
                        filter_lines.append(f"[padded{i}]zoompan=z=1.1:x='({cx})-50+0.4*on':y='{cy}':d={frames}:{zoom_base}[v{i}];")
                    elif clip.get("effect") == "pan_left":
                        filter_lines.append(f"[padded{i}]zoompan=z=1.1:x='({cx})+50-0.4*on':y='{cy}':d={frames}:{zoom_base}[v{i}];")
                    else:
                        filter_lines.append(f"[padded{i}]zoompan=z=1.0:x='{cx}':y='{cy}':d={frames}:{zoom_base}[v{i}];")
                        
                    if aud_in_idx is not None:
                        a_filter = f"[{aud_in_idx}:a]aresample=44100,apad=whole_dur={clip['duration']}[a{i}];"
                        filter_lines.append(a_filter)
                    else:
                        a_filter = f"anullsrc=channel_layout=stereo:sample_rate=44100:d={clip['duration']}[a{i}];"
                        filter_lines.append(a_filter)

                # Combine using xfade for video and acrossfade for audio
                if len(chunk_clips) == 1:
                    filter_lines.append(f"[v0]copy[vpanels];")
                    filter_lines.append(f"[a0]acopy[aout];")
                else:
                    current_v = "[v0]"
                    current_a = "[a0]"
                    v_offset = chunk_clips[0]['duration']
                    
                    for i in range(1, len(chunk_clips)):
                        v_offset -= trans_dur
                        next_v = f"[v{i}]"
                        next_a = f"[a{i}]"
                        out_v = f"vout{i}"
                        out_a = f"aout{i}"
                        
                        filter_lines.append(f"{current_v}{next_v}xfade=transition=slideleft:duration={trans_dur}:offset={v_offset}[{out_v}];")
                        filter_lines.append(f"{current_a}{next_a}acrossfade=d={trans_dur}[{out_a}];")
                        
                        current_v = f"[{out_v}]"
                        current_a = f"[{out_a}]"
                        v_offset += chunk_clips[i]['duration']
                    
                    filter_lines.append(f"{current_v}copy[vpanels];")
                    filter_lines.append(f"{current_a}acopy[aout];")
                    
                # Finally overlay the sliding panels onto the static background
                if bg_in_idx is not None:
                    filter_lines.append(f"[{bg_in_idx}:v][vpanels]overlay=(W-w)/2:(H-h)/2:shortest=1:format=auto,setsar=1/1[vout];")
                else:
                    filter_lines.append(f"[vpanels]format=yuv420p,setsar=1/1[vout];")
                
                with open(filter_script_path, "w", encoding="utf-8") as f:
                    f.write("\n".join(filter_lines))
                    
                report_progress("recording", f"Starting chunk {chunk_idx+1}/{len(chunks)}...", elapsed=time.time() - start_time, remaining=total_duration)
                
                inputs_str = " ".join(inputs)
                cmd = f'ffmpeg -y -nostdin {inputs_str} -filter_complex_script "{filter_script_path}" -map "[vout]" -map "[aout]" -c:v h264_nvenc -preset p6 -b:v 8000k -c:a aac -b:a 192k -t {chunk_dur} "{chunk_output}"'
                
                args = shlex.split(cmd)
                stderr_log_path = self.output_dir / f"stderr_{job_id}_{chunk_idx}.log"
                with open(stderr_log_path, "w") as f_err:
                    import subprocess
                    proc_result = await asyncio.to_thread(
                        subprocess.run,
                        args,
                        stdin=subprocess.DEVNULL,
                        stdout=subprocess.DEVNULL,
                        stderr=f_err
                    )
                
                if proc_result.returncode != 0:
                    err_msg = open(stderr_log_path).read() if os.path.exists(stderr_log_path) else "Unknown error"
                    return {"status": "error", "error": f"FFmpeg failed on chunk {chunk_idx}: {err_msg[-500:]}"}
                    
                chunk_files[chunk_idx] = chunk_output
                return {"status": "ok"}

            my_sem = asyncio.Semaphore(2)
            async def bounded_render_chunk_func(i, ch):
                async with my_sem:
                    return await render_chunk_func(i, ch)

            tasks = [bounded_render_chunk_func(i, ch) for i, ch in enumerate(chunks)]
            results = await asyncio.gather(*tasks)
            for res in results:
                if res.get("status") == "error":
                    return res
                    
            # Concat chunks
            report_progress("processing", "Merging video chunks...", elapsed=time.time() - start_time, remaining=10, progress=96)
            concat_list_path = self.output_dir / f"concat_{job_id}.txt"
            with open(concat_list_path, "w", encoding="utf-8") as f:
                for ch_file in chunk_files:
                    f.write(f"file '{ch_file.name}'\n")
                    
            concat_cmd = f'ffmpeg -y -f concat -safe 0 -i "{concat_list_path}" -c copy "{output_path}"'
            concat_err_path = self.output_dir / f"concat_err_{job_id}.log"
            with open(concat_err_path, "w") as f_err:
                import subprocess
                proc_concat_result = await asyncio.to_thread(
                    subprocess.run,
                    shlex.split(concat_cmd),
                    stdout=subprocess.DEVNULL,
                    stderr=f_err,
                    timeout=600
                )
            
            # Cleanup chunks
            try:
                os.remove(concat_list_path)
                for ch_file in chunk_files:
                    os.remove(ch_file)
            except:
                pass

            if proc_concat_result.returncode != 0:
                err_msg = open(concat_err_path).read() if os.path.exists(concat_err_path) else "Unknown concat error"
                return {"status": "error", "error": f"Failed to merge chunks: {err_msg[-200:]}"}

            elapsed = time.time() - start_time
            file_size = output_path.stat().st_size
            
            report_progress("complete", f"Video ready! ({file_size / 1024 / 1024:.1f} MB)",
                          elapsed=elapsed,
                          remaining=0,
                          total_duration=total_duration,
                          progress=100)
            
            import shutil
        
            # Determine the user's desired final save path
            project_id = project.get("id", "unknown_project")
            
            from mangaeditor import EditorDB
            db = EditorDB()
            series_id = project.get('manga_series_id')
            series = db.get_manga_series(series_id) if series_id else {}
            
            series_title = series.get('name', 'Unknown')
            
            manga_folder = os.path.join(BASE_DIR, "renders", series_title)
            if not os.path.exists(manga_folder):
                os.makedirs(manga_folder, exist_ok=True)
            
            chapter_num = "Unknown"
            if series and 'chapters' in series:
                for ch in series['chapters']:
                    if ch.get('id') == project_id:
                        chapter_num = str(ch.get('chapter_number', 'Unknown'))
                        # For floats like 7.0, simplify to 7
                        if chapter_num.endswith('.0'):
                            chapter_num = chapter_num[:-2]
                        break
                        
            final_file_name = f"{series_title}_Ch{chapter_num}.mp4".replace(" ", "_")
            import re
            final_file_name = re.sub(r'[\\/*?:"<>|]', "", final_file_name)
            
            final_save_path = os.path.join(manga_folder, final_file_name)
            
            # Copy the rendered file to the target location
            shutil.copy2(output_path, final_save_path)
            print(f"File successfully saved to {final_save_path}")

            return {
                "status": "success",
                "output_path": str(output_path),
                "final_save_path": final_save_path,
                "output_url": str(output_path).replace(str(BASE_DIR), "").replace("\\", "/"),
                "duration": total_duration,
                "elapsed_time": elapsed,
                "file_size": file_size,
                "format": "mp4",
                "metadata_fixed": True
            }
                
        except Exception as e:
            logger.error(f"[FFmpeg] Recording failed: {e}", exc_info=True)
            return {
                "status": "error",
                "error": str(e)
            }


async def record_project_ffmpeg(project_id: str, progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None, **kwargs) -> Dict[str, Any]:
    """
    Convenience function to record a project natively via FFmpeg.
    """
    recorder = FFmpegRenderer()
    return await recorder.record_project(project_id, progress_callback=progress_callback, **kwargs)

def record_project_ffmpeg_sync(project_id: str, progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None, **kwargs) -> Dict[str, Any]:
    """
    Synchronous wrapper for FastAPI endpoints.
    """
    return asyncio.run(record_project_ffmpeg(project_id, progress_callback=progress_callback, **kwargs))
