---
name: ffmpeg-manga-renderer
description: Guidelines and template code for rendering manga panels with FFmpeg using supersampled zoompan, transparent padding, and xfade slide transitions over a static background.
---
# FFmpeg Manga Renderer Skill

When working on or regenerating the FFmpeg rendering logic for manga panels (`ffmpeg_renderer.py`), always follow these specific techniques to ensure high-quality animations without jitter or background loops.

## Core Principles

1. **Static Background**: Never apply `-loop 1` to the background image *before* the panel overlay if the panel has transitions. Instead, overlay the fully rendered panel timeline (with transitions) onto a single `-loop 1` background video stream using `shortest=1`.
2. **Supersampled Zoompan**: `zoompan` suffers from sub-pixel rounding jitter during slow zooms. To fix this, scale the panel up by a supersampling factor (e.g., `ss=2`) and pad it to the supersampled canvas size (e.g., 3840x2160) *before* applying `zoompan`. `zoompan` will then output the final 1080p resolution (`s=1920x1080`).
3. **Growing Bounding Box**: To make the panel grow on the screen (rather than cropping within a fixed box), pad the panel to the full canvas size with a transparent background (`color=black@0.0:format=rgba`) *before* zooming. When `zoompan` zooms into the center, the panel grows naturally.
4. **Slide Transitions on Transparent Canvas**: Apply `xfade` (e.g., `slideleft`) to the transparent panel video streams *before* overlaying them onto the background. This ensures only the panels slide, not the background.

## Template Code

See `examples/renderer_template.py` for the full implementation of the chunk rendering filter graph generation.
