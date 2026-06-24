# Template for generating the FFmpeg complex filter script for smooth manga panel rendering
# This logic handles supersampled zoompan, transparent padded canvas, and xfade panel transitions over a static background.

def generate_filter_script(chunk_clips, bg_path):
    filter_lines = []
    inputs = []
    input_idx = 0
    trans_dur = 0.5
    
    # 1. Background (Looping)
    if bg_path:
        inputs.append(f'-loop 1 -i "{bg_path}"')
        bg_in_idx = input_idx
        input_idx += 1
    else:
        bg_in_idx = None
        
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
        
        if clip.get("audio"):
            inputs.append(f'-i "{clip["audio"]}"')
            aud_in_idx = input_idx
            input_idx += 1
        else:
            aud_in_idx = None
            
        frames = int(clip['duration']*24)
        
        # Scale panel to target size and pad to canvas size with transparent background
        scale_to_box = f"scale={panel_res}:force_original_aspect_ratio=decrease"
        pad_to_canvas = f"pad={canvas_res.replace('x', ':')}:(ow-iw)/2:(oh-ih)/2:color=black@0.0"
        filter_lines.append(f"[{img_in_idx}:v]format=rgba,{scale_to_box},{pad_to_canvas}[padded{i}];")
        
        # Zoompan the padded canvas (so the panel grows/shrinks naturally)
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

    return filter_lines, inputs
