"""
Headless Browser Recording Module

This module uses Playwright to launch a headless Chromium browser that can
properly capture both video and audio from the video editor canvas.

This solves the browser limitation where client-side JavaScript cannot capture
audio from <audio> elements due to security restrictions.
"""

import asyncio
import os
import time
import uuid
import subprocess
import shutil
from pathlib import Path
from typing import Optional, Dict, Any, Callable
import logging

logger = logging.getLogger("headless_recorder")

# Check if FFmpeg is available for metadata fixing
def check_ffmpeg():
    """Check if FFmpeg is available in the system."""
    return shutil.which('ffmpeg') is not None

FFMPEG_AVAILABLE = check_ffmpeg()

# Check if playwright is available
try:
    from playwright.async_api import async_playwright, Browser, Page
    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False
    logger.warning("Playwright not installed. Headless recording unavailable.")
    logger.warning("Install with: pip install playwright && playwright install chromium")


class HeadlessRecorder:
    """
    Records video editor output using a headless browser.
    Captures both video and audio properly.
    """
    
    def __init__(self, base_url: str = "http://127.0.0.1:8000", output_dir: str = "renders"):
        self.base_url = base_url
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(exist_ok=True)
        
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
        """
        Record a project using headless browser.
        
        Args:
            project_id: The project ID to record
            duration: Duration in seconds (None = auto-detect from timeline)
            width: Video width in pixels
            height: Video height in pixels
            fps: Frames per second
            audio_bitrate: Audio bitrate (e.g., "128k")
            video_bitrate: Video bitrate (e.g., "5M")
            progress_callback: Optional callback function to report progress
            
        Returns:
            Dict with status, output_path, and metadata
        """
        def report_progress(stage: str, detail: str = "", **kwargs):
            """Helper to report progress if callback is provided."""
            if progress_callback:
                event_data = {"stage": stage, "detail": detail, **kwargs}
                logger.info(f"[Progress] Sending: {stage} - {detail}")
                progress_callback(event_data)
            else:
                logger.warning("[Progress] No callback provided!")
        
        if not PLAYWRIGHT_AVAILABLE:
            return {
                "status": "error",
                "error": "Playwright not installed. Run: pip install playwright && playwright install chromium"
            }
        
        start_time = time.time()
        job_id = uuid.uuid4().hex[:8]
        output_filename = f"headless-recording-{project_id}-{job_id}.webm"
        output_path = self.output_dir / output_filename
        
        report_progress("initializing", "Starting headless browser...", elapsed=0, remaining=None)
        
        logger.info(f"[Headless] Starting recording for project {project_id}")
        logger.info(f"[Headless] Output: {output_path}")
        
        try:
            async with async_playwright() as p:
                # Launch browser with audio/video capture enabled
                browser = await p.chromium.launch(
                    headless=True,
                    args=[
                        '--autoplay-policy=no-user-gesture-required',
                        '--disable-blink-features=AutomationControlled',
                        '--disable-web-security',  # Allow cross-origin for local files
                        '--use-fake-ui-for-media-stream',  # Auto-allow media permissions
                        '--allow-file-access-from-files',
                        f'--window-size={width},{height}'
                    ]
                )
                
                logger.info("[Headless] Browser launched")
                report_progress("browser_ready", "Browser launched successfully", elapsed=time.time() - start_time, remaining=None)
                
                # Create a new page (NO record_video_dir - we'll use canvas recording)
                page = await browser.new_page(
                    viewport={'width': width, 'height': height}
                )
                
                # Navigate to the video editor
                editor_url = f"{self.base_url}/editor/video-editor/{project_id}"
                logger.info(f"[Headless] Navigating to {editor_url}")
                
                report_progress("loading_page", "Loading video editor...", elapsed=time.time() - start_time, remaining=None)
                
                await page.goto(editor_url, wait_until='networkidle', timeout=60000)
                logger.info("[Headless] Page loaded")
                
                # Wait for the editor to initialize
                await page.wait_for_selector('#editorCanvas', timeout=30000)
                logger.info("[Headless] Canvas found")
                
                report_progress("assets_loading", "Loading assets...", elapsed=time.time() - start_time, remaining=None)
                
                # Wait for values to be populated
                try:
                    await page.wait_for_function('() => window.videoEditorLoaded === true', timeout=60000)
                    logger.info("[Headless] Editor fully loaded (window.videoEditorLoaded=true)")
                except Exception:
                    logger.warning("[Headless] Timeout waiting for videoEditorLoaded, proceeding anyway...")
                    await asyncio.sleep(5)

                
                # Auto-generate timeline if requested
                if auto_generate_timeline:
                    logger.info("[Headless] Auto-generating timeline...")
                    report_progress("generating_timeline", "Auto-generating timeline...", elapsed=time.time() - start_time, remaining=None)
                    
                    await page.evaluate("""
                        async () => {
                            console.log('[Headless] Triggering auto-generation sequence...');
                            
                            // 1. Verify we have assets
                            if (!window.panels || window.panels.length === 0) {
                                console.warn('[Headless] No panels found in window.panels!');
                            }
                            if (!window.audios || window.audios.length === 0) {
                                console.warn('[Headless] No audios found in window.audios!');
                            }

                            // 2. Generate Timeline
                            if (typeof generatePanelTimeline === 'function') {
                                try {
                                    console.log('[Headless] Calling generatePanelTimeline()...');
                                    await generatePanelTimeline();
                                    console.log('[Headless] generatePanelTimeline returned.');
                                    
                                    // Verify result
                                    const allClips = typeof flattenLayersToTimeline === 'function' ? flattenLayersToTimeline() : [];
                                    const hasContent = allClips.some(c => !c._isBackground);
                                    
                                    if (!hasContent) {
                                        console.error('[Headless] Timeline appears empty after generation!');
                                        // Attempt one retry just in case
                                        console.log('[Headless] Retrying generation...');
                                        await new Promise(r => setTimeout(r, 1000));
                                        await generatePanelTimeline();
                                        
                                        const retryClips = typeof flattenLayersToTimeline === 'function' ? flattenLayersToTimeline() : [];
                                        if (retryClips.some(c => !c._isBackground)) {
                                             console.log('[Headless] Retry successful!');
                                        } else {
                                             throw new Error('Timeline generation failed to produce any clips.');
                                        }
                                    } else {
                                        console.log(`[Headless] Timeline generated with ${allClips.length} clips.`);
                                    }
                                } catch (e) {
                                    console.error('[Headless] Error generating timeline:', e);
                                    throw e;
                                }
                            } else {
                                console.error('[Headless] generatePanelTimeline function not found');
                            }
                            
                            // 3. Save Project
                            console.log('[Headless] Saving project...');
                            if (typeof saveProject === 'function') {
                                try {
                                    await saveProject(true); // force save
                                    console.log('[Headless] Project saved');
                                } catch (e) {
                                    console.error('[Headless] Error saving project:', e);
                                    throw e;
                                }
                            }
                        }
                    """)
                    
                    # Give it a moment to update DOM and state
                    await asyncio.sleep(2)

                
                # Get the actual timeline duration if not specified
                # Get the actual timeline duration if not specified
                if duration is None:
                    try:
                         # Try computeTotalDuration first, then fallback
                        duration = await page.evaluate("() => typeof computeTotalDuration === 'function' ? computeTotalDuration() : (typeof getCanvasTotalDuration === 'function' ? getCanvasTotalDuration() : 0)")
                        logger.info(f"[Headless] Detected duration: {duration}s")
                    except Exception as e:
                        logger.warning(f"[Headless] Could not detect duration: {e}")
                        duration = 0

                    
                    # Safe fallback: If duration is 0 (and we didn't just generate it), try generating it now!
                    # This handles the case where user forgot to check "Force re-generate" but the project has no timeline.
                    if (duration is None or duration <= 0.1) and not auto_generate_timeline:
                        logger.warning("[Headless] Duration is 0s! Timeline seems empty. Attempting auto-generation fallback...")
                        try:
                            # Re-run the generation logic
                            await page.evaluate("""
                                async () => {
                                    console.log('[Headless] Fallback: Auto-generating timeline because duration was 0...');
                                    
                                    // 1. Fallback for project data
                                    if (!window.projectData && typeof refreshProjectData === 'function') {
                                        await refreshProjectData();
                                    }
                                    
                                    // 2. Generate
                                    if (typeof generatePanelTimeline === 'function') {
                                        await generatePanelTimeline();
                                        
                                        // Verify
                                        const allClips = typeof flattenLayersToTimeline === 'function' ? flattenLayersToTimeline() : [];
                                        if (allClips.some(c => !c._isBackground)) {
                                            console.log('[Headless] Fallback generation successful!');
                                        } else {
                                            console.error('[Headless] Fallback generation result still empty.');
                                        }
                                    } else {
                                         console.error('[Headless] generatePanelTimeline not found for fallback.');
                                    }
                                    
                                    // 3. Save
                                     if (typeof saveProject === 'function') await saveProject(true);
                                }
                            """)
                            # give it a sec
                            await asyncio.sleep(2)
                            # Re-check duration
                            duration = await page.evaluate("() => typeof computeTotalDuration === 'function' ? computeTotalDuration() : 0")
                            logger.info(f"[Headless] New duration after fallback: {duration}s")
                        except Exception as e:
                            logger.error(f"[Headless] Fallback generation failed: {e}")
                    
                    # Updates progress
                    if duration:
                         report_progress("duration_detected", f"Video duration: {duration:.1f}s", 
                                      elapsed=time.time() - start_time, 
                                      remaining=duration + 10,
                                      total_duration=duration)
                    else:
                        duration = 2 # Default fallback if really empty
                
                # Initialize canvas recording with audio capture
                logger.info("[Headless] Setting up canvas recording with audio...")
                report_progress("setup_recording", "Initializing recorder...", elapsed=time.time() - start_time, 
                              remaining=duration + 8 if duration else None, total_duration=duration)
                
                await page.evaluate("""
                    () => {
                        return new Promise((resolve, reject) => {
                            try {
                                // Get canvas element
                                const canvas = document.getElementById('editorCanvas');
                                if (!canvas) {
                                    reject('Canvas not found');
                                    return;
                                }
                                
                                // Capture canvas stream (video only)
                                const canvasStream = canvas.captureStream(30); // 30 fps
                                console.log('[Headless] Canvas stream captured:', canvasStream.getVideoTracks().length, 'video tracks');
                                
                                // Create Web Audio API context for audio capture
                                window.audioCtx = window.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
                                const audioDestination = window.audioCtx.createMediaStreamDestination();
                                
                                // Find all audio elements and route them to the destination
                                const audioElements = Array.from(document.querySelectorAll('audio'));
                                console.log('[Headless] Found', audioElements.length, 'audio elements');
                                
                                audioElements.forEach((audioEl, idx) => {
                                    try {
                                        const source = window.audioCtx.createMediaElementSource(audioEl);
                                        source.connect(audioDestination);
                                        // Also connect to speakers so we can hear it
                                        source.connect(window.audioCtx.destination);
                                        console.log('[Headless] Routed audio element', idx, 'to destination');
                                    } catch (err) {
                                        // Element might already be connected
                                        console.warn('[Headless] Could not route audio element', idx, ':', err.message);
                                    }
                                });
                                
                                // Combine canvas video stream with audio destination stream
                                const combinedStream = new MediaStream();
                                
                                // Add video tracks from canvas
                                canvasStream.getVideoTracks().forEach(track => {
                                    combinedStream.addTrack(track);
                                    console.log('[Headless] Added video track:', track.label);
                                });
                                
                                // Add audio tracks from Web Audio API destination
                                audioDestination.stream.getAudioTracks().forEach(track => {
                                    combinedStream.addTrack(track);
                                    console.log('[Headless] Added audio track:', track.label);
                                });
                                
                                console.log('[Headless] Combined stream has', combinedStream.getVideoTracks().length, 'video and', combinedStream.getAudioTracks().length, 'audio tracks');
                                
                                // Create MediaRecorder
                                window.headlessRecorder = new MediaRecorder(combinedStream, {
                                    mimeType: 'video/webm;codecs=vp8,opus',
                                    videoBitsPerSecond: 5000000, // 5 Mbps
                                    audioBitsPerSecond: 128000   // 128 kbps
                                });
                                
                                window.headlessChunks = [];
                                
                                window.headlessRecorder.ondataavailable = (e) => {
                                    if (e.data && e.data.size > 0) {
                                        window.headlessChunks.push(e.data);
                                        console.log('[Headless] Chunk received:', e.data.size, 'bytes, total chunks:', window.headlessChunks.length);
                                    }
                                };
                                
                                window.headlessRecorder.onstop = () => {
                                    console.log('[Headless] Recording stopped, total chunks:', window.headlessChunks.length);
                                };
                                
                                window.headlessRecorder.onerror = (e) => {
                                    console.error('[Headless] Recorder error:', e);
                                };
                                
                                // Start recording
                                window.headlessRecorder.start(100); // Get chunks every 100ms
                                console.log('[Headless] MediaRecorder started, state:', window.headlessRecorder.state);
                                
                                resolve({
                                    videoTracks: combinedStream.getVideoTracks().length,
                                    audioTracks: combinedStream.getAudioTracks().length,
                                    recorderState: window.headlessRecorder.state
                                });
                                
                            } catch (err) {
                                reject(err.message);
                            }
                        });
                    }
                """)
                
                logger.info("[Headless] Canvas recording initialized")
                report_progress("recording_ready", "Recorder ready, starting playback...", elapsed=time.time() - start_time,
                              remaining=duration + 5 if duration else None, total_duration=duration)
                
                # Reset playhead and start playback
                logger.info("[Headless] Starting playback...")
                
                await page.evaluate("""
                    () => {
                        // Ensure audio context if not already created
                        if (!window.audioCtx) {
                            try {
                                window.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                            } catch (e) {
                                console.warn('[Headless] Could not create AudioContext:', e);
                            }
                        }
                        
                        // Reset playhead to start
                        if (typeof playhead !== 'undefined') {
                            playhead = 0;
                        }
                        
                        // Start playback
                        if (typeof togglePlayback === 'function') {
                            if (!isPlaying) {
                                togglePlayback();
                            }
                        } else {
                            console.error('[Headless] togglePlayback function not found');
                            throw new Error('togglePlayback function not defined');
                        }
                    }
                """)
                
                logger.info(f"[Headless] Recording for {duration + 2} seconds...")
                report_progress("recording", "Recording in progress...", 
                              elapsed=time.time() - start_time,
                              remaining=duration + 2,
                              total_duration=duration,
                              progress=0)
                
                # Record with progress updates every second
                recording_start = time.time()
                total_recording_time = duration + 2
                
                for i in range(int(total_recording_time)):
                    await asyncio.sleep(1)
                    elapsed_recording = time.time() - recording_start
                    remaining_recording = max(0, total_recording_time - elapsed_recording)
                    progress_pct = min(95, int((elapsed_recording / total_recording_time) * 100))
                    
                    report_progress("recording", f"Recording... {elapsed_recording:.0f}s / {total_recording_time:.0f}s",
                                  elapsed=time.time() - start_time,
                                  remaining=remaining_recording + 5,  # Add processing time
                                  total_duration=duration,
                                  progress=progress_pct)
                
                # Wait for any remaining fractional seconds
                final_wait = total_recording_time - int(total_recording_time)
                if final_wait > 0:
                    await asyncio.sleep(final_wait)
                
                # Stop playback
                await page.evaluate("""
                    () => {
                        if (typeof togglePlayback === 'function' && typeof isPlaying !== 'undefined') {
                            if (isPlaying) {
                                togglePlayback();
                            }
                        }
                    }
                """)
                
                logger.info("[Headless] Playback stopped, stopping recorder...")
                report_progress("processing", "Stopping recorder and processing video...",
                              elapsed=time.time() - start_time,
                              remaining=5,
                              total_duration=duration,
                              progress=96)
                
                # Define temp path outside try block
                temp_path = output_path.with_suffix('.temp.webm')
                
                # Stop the recorder and save the blob directly to avoid base64 timeout
                try:
                    # First, stop the recorder
                    await page.evaluate("""
                        () => {
                            if (window.headlessRecorder && window.headlessRecorder.state !== 'inactive') {
                                window.headlessRecorder.stop();
                            }
                        }
                    """)
                    
                    logger.info("[Headless] Recorder stopped, waiting for blob creation...")
                    
                    # Wait a bit for the recorder to finish processing
                    await asyncio.sleep(2)
                    
                    # Get blob info and trigger download via browser
                    blob_size = await page.evaluate("""
                        () => {
                            if (!window.headlessChunks || window.headlessChunks.length === 0) {
                                return 0;
                            }
                            const blob = new Blob(window.headlessChunks, { type: 'video/webm' });
                            window.recordedBlob = blob;
                            return blob.size;
                        }
                    """)
                    
                    if blob_size == 0:
                        logger.error("[Headless] No video data in chunks")
                        await browser.close()
                        return {
                            "status": "error",
                            "error": "No video data was recorded (empty chunks)"
                        }
                    
                    logger.info(f"[Headless] Blob created, size: {blob_size / 1024 / 1024:.2f} MB")
                    
                    report_progress("downloading", f"Saving video ({blob_size / 1024 / 1024:.1f} MB)...",
                                  elapsed=time.time() - start_time,
                                  remaining=3,
                                  total_duration=duration,
                                  progress=97)
                    
                    # For large videos, use download instead of base64
                    # This avoids memory issues and timeouts
                    logger.info("[Headless] Triggering browser download...")
                    
                    # Wait for download to start (with timeout)
                    async with page.expect_download(timeout=120000) as download_info:  # 2 min timeout
                        # Trigger download in browser
                        await page.evaluate("""
                            () => {
                                const blob = window.recordedBlob;
                                const url = URL.createObjectURL(blob);
                                const a = document.createElement('a');
                                a.href = url;
                                a.download = 'recording.webm';
                                document.body.appendChild(a);
                                a.click();
                                document.body.removeChild(a);
                                URL.revokeObjectURL(url);
                            }
                        """)
                    
                    download = await download_info.value
                    logger.info("[Headless] Download started, saving to disk...")
                    
                    # Save the downloaded file
                    await download.save_as(str(temp_path))
                    logger.info(f"[Headless] File saved to {temp_path}")
                    
                except asyncio.TimeoutError:
                    logger.error("[Headless] Timeout while getting video data")
                    await browser.close()
                    return {
                        "status": "error",
                        "error": "Timeout while retrieving recorded video (file too large)"
                    }
                except Exception as e:
                    logger.error(f"[Headless] Error getting video data: {e}")
                    await browser.close()
                    return {
                        "status": "error",
                        "error": f"Failed to retrieve video data: {str(e)}"
                    }
                
                # Close browser
                await browser.close()
                
                # Fix WebM metadata (duration) using FFmpeg if available
                if FFMPEG_AVAILABLE:
                    logger.info("[Headless] Fixing WebM metadata with FFmpeg...")
                    report_progress("fixing_metadata", "Fixing video metadata...",
                                  elapsed=time.time() - start_time,
                                  remaining=2,
                                  total_duration=duration,
                                  progress=98)
                    success = await self._fix_webm_duration(temp_path, output_path, duration)
                    
                    if success:
                        logger.info("[Headless] Metadata fixed successfully")
                        # Remove temp file
                        temp_path.unlink()
                    else:
                        logger.warning("[Headless] Metadata fix failed, using original file")
                        # Just rename temp to final
                        temp_path.rename(output_path)
                else:
                    logger.warning("[Headless] FFmpeg not available, duration metadata will be missing")
                    logger.warning("[Headless] Install FFmpeg to fix: https://ffmpeg.org/download.html")
                    # Just rename temp to final
                    temp_path.rename(output_path)
                
                elapsed = time.time() - start_time
                file_size = output_path.stat().st_size
                
                logger.info(f"[Headless] Recording complete: {output_path}")
                logger.info(f"[Headless] Duration: {elapsed:.2f}s, Size: {file_size / 1024 / 1024:.2f}MB")
                
                report_progress("complete", f"Video ready! ({file_size / 1024 / 1024:.1f} MB)",
                              elapsed=elapsed,
                              remaining=0,
                              total_duration=duration,
                              progress=100)
                
                return {
                    "status": "success",
                    "output_path": str(output_path),
                    "output_url": f"/manga_projects/renders/{output_filename}",
                    "duration": duration,
                    "elapsed_time": elapsed,
                    "file_size": file_size,
                    "format": "webm",
                    "metadata_fixed": FFMPEG_AVAILABLE
                }
                    
        except Exception as e:
            logger.error(f"[Headless] Recording failed: {e}", exc_info=True)
            return {
                "status": "error",
                "error": str(e)
            }
    
    async def _fix_webm_duration(self, input_path: Path, output_path: Path, duration: float) -> bool:
        """
        Fix WebM duration metadata using FFmpeg.
        
        MediaRecorder doesn't write duration to WebM files, causing players
        like VLC to show unknown duration. FFmpeg can remux the file to add
        proper metadata.
        
        Args:
            input_path: Path to the input WebM file (without metadata)
            output_path: Path to the output WebM file (with metadata)
            duration: Expected duration in seconds
            
        Returns:
            True if successful, False otherwise
        """
        try:
            # Use FFmpeg to remux the file (copy codecs, add metadata)
            # -i: input file
            # -c copy: copy video and audio codecs without re-encoding (fast!)
            # -y: overwrite output file
            cmd = [
                'ffmpeg',
                '-i', str(input_path),
                '-c', 'copy',  # Copy streams without re-encoding
                '-y',  # Overwrite output
                str(output_path)
            ]
            
            logger.info(f"[Headless] Running FFmpeg: {' '.join(cmd)}")
            
            # Run FFmpeg (synchronous, but fast since we're just copying)
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=60  # 60 second timeout
            )
            
            if result.returncode == 0:
                logger.info("[Headless] FFmpeg completed successfully")
                return True
            else:
                logger.error(f"[Headless] FFmpeg failed with code {result.returncode}")
                logger.error(f"[Headless] FFmpeg stderr: {result.stderr}")
                return False
                
        except subprocess.TimeoutExpired:
            logger.error("[Headless] FFmpeg timed out")
            return False
        except Exception as e:
            logger.error(f"[Headless] FFmpeg error: {e}")
            return False


async def record_project_headless(project_id: str, progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None, **kwargs) -> Dict[str, Any]:
    """
    Convenience function to record a project.
    """
    recorder = HeadlessRecorder()
    return await recorder.record_project(project_id, progress_callback=progress_callback, **kwargs)


# Synchronous wrapper for use in FastAPI
def record_project_sync(project_id: str, progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None, **kwargs) -> Dict[str, Any]:
    """
    Synchronous wrapper for FastAPI endpoints.
    """
    return asyncio.run(record_project_headless(project_id, progress_callback=progress_callback, **kwargs))
