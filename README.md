# Context-Aware Manga Narrator App

An AI-powered web application that automatically detects panels in manga/comic pages and generates contextual narration using Google Gemini. The app uses external APIs for panel detection and provides a two-step workflow for reviewing detected panels before generating narration.

## Features

- **External Panel Detection**: Integrates with MagiV3 or other panel detection APIs via HTTP
- **Two-Step Workflow**: First detect and review panels, then generate narration per page
- **Context-Aware Narration**: Maintains story context across pages using Google Gemini
- **Panel Preview**: Shows cropped panel images in the UI for review
- **Flexible API Support**: Handles JSON, ZIP, or single image responses from detection APIs

## Quick Start

1. **Setup Environment**
   ```bash
   # Create virtual environment
   python -m venv venv
   
   # Activate (Windows)
   .\venv\Scripts\Activate.ps1
   # Activate (macOS/Linux)
   source venv/bin/activate
   
   # Install dependencies
   pip install -r requirements.txt
   ```

2. **Configure Environment Variables**
   
   Create a `.env` file in the project root:
   ```env
   # Required: Google Gemini API key
   GOOGLE_API_KEY=your_gemini_api_key_here
   
   # Required: External panel detection API URL
   PANEL_API_URL=https://your-ngrok-domain.ngrok-free.app/split_panels
   
   # Optional: API response mode (auto|json|zip|image)
   PANEL_API_MODE=auto
   ```

3. **Start the Server**
   ```bash
   uvicorn main:app --reload
   ```

4. **Open the App**
   Navigate to `http://localhost:8000/`

## Usage Workflow

### Step 1: Upload Images
- Click "Choose Files" and select manga/comic page images
- Images are uploaded and stored in the `uploads/` directory
- Supported formats: PNG, JPG, JPEG, WEBP

### Step 2: Detect Panels
- Click "Start Narration" to begin panel detection
- The app sends each image to your configured `PANEL_API_URL`
- Detected panels are cropped and saved as individual images
- Panel previews are displayed in the UI for review

### Step 3: Generate Narration
- For each page, click "Generate Narration for This Page"
- The app sends panel images to Google Gemini with story context
- Narration is generated and displayed below the panel previews
- Story context is maintained across all pages

## API Endpoints

### Frontend Endpoints
- `GET /` - Main application interface
- `POST /upload` - Upload manga page images
- `POST /detect-panels` - Detect panels using external API
- `POST /process-page` - Generate narration for a specific page

### Static Files
- `/uploads/` - Serves uploaded images and generated panel crops
- `/static/` - Serves CSS and JavaScript files

## External Panel Detection API

The app integrates with external panel detection services. Your API should:

### Expected Endpoint
- **URL**: `POST /split_panels`
- **Input**: Multipart form data with `file` field containing image
- **Output**: ZIP file containing cropped panel images named `panel_1.png`, `panel_2.png`, etc.

### Example API Implementation (MagiV3)
```python
@app.post("/split_panels")
async def split_panels(file: UploadFile = File(...)):
    # Load and process image
    contents = await file.read()
    image = Image.open(io.BytesIO(contents)).convert("RGB")
    
    # Detect panels using your model
    results = MODEL.predict_detections_and_associations([image], PROCESSOR)
    panel_boxes = results[0]["panels"]
    
    # Create ZIP with all panels
    zip_buf = io.BytesIO()
    with zipfile.ZipFile(zip_buf, "w") as zipf:
        for i, bbox in enumerate(panel_boxes):
            panel_image = image.crop(bbox)
            img_bytes = io.BytesIO()
            panel_image.save(img_bytes, format="PNG")
            zipf.writestr(f"panel_{i+1}.png", img_bytes.read())
    
    return StreamingResponse(
        zip_buf,
        media_type="application/zip",
        headers={"Content-Disposition": "attachment; filename=panels.zip"}
    )
```

## Project Structure

```
.
├── main.py                 # FastAPI backend application
├── requirements.txt        # Python dependencies
├── .env                   # Environment variables (create this)
├── .gitignore            # Git ignore rules
├── README.md             # This file
├── templates/
│   └── index.html        # Main web interface
├── static/
│   └── script.js         # Frontend JavaScript
└── uploads/              # Generated at runtime
    ├── image1.png        # Uploaded manga pages
    ├── image2.png
    └── panels/           # Generated panel crops
        ├── image1/
        │   ├── panel_01.png
        │   └── panel_02.png
        └── image2/
            ├── panel_01.png
            └── panel_02.png
```

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GOOGLE_API_KEY` | Yes | - | Google Gemini API key for narration generation |
| `PANEL_API_URL` | Yes | - | URL of external panel detection API |
| `PANEL_API_MODE` | No | `auto` | Response format: `auto`, `json`, `zip`, or `image` |

### Optional Local Detectors

The app includes several local panel detection methods (currently bypassed in favor of external API):

- **LayoutParser**: Detectron2-based layout analysis
- **YOLOv8**: Object detection with custom weights
- **OWL-ViT**: Prompt-based zero-shot detection
- **DeepPanel**: U-Net segmentation model
- **OpenCV**: Heuristic border detection

To enable local detection, set the appropriate environment variables and disable the external API by removing `PANEL_API_URL`.

## Dependencies

### Core Dependencies
- `fastapi` - Web framework
- `uvicorn` - ASGI server
- `python-multipart` - File upload support
- `Pillow` - Image processing
- `google-generativeai` - Gemini API client
- `python-dotenv` - Environment variable loading

### Optional Dependencies
- `requests` - HTTP client for external APIs
- `transformers` - OWL-ViT and other models
- `ultralytics` - YOLOv8 models
- `tensorflow` - DeepPanel models
- `opencv-python-headless` - OpenCV detection
- `layoutparser` - Layout analysis

## Troubleshooting

### Common Issues

1. **"PANEL_API_URL not configured"**
   - Set `PANEL_API_URL` in your `.env` file
   - Ensure the URL is accessible and returns a ZIP file

2. **"Gemini not available"**
   - Set `GOOGLE_API_KEY` in your `.env` file
   - Verify the API key is valid and has quota remaining

3. **Panel detection fails**
   - Check that your external API is running and accessible
   - Verify the API returns the expected ZIP format
   - Check server logs for detailed error messages

4. **No panels detected**
   - Ensure your detection API is working correctly
   - Try with different manga pages
   - Check that the API returns panels in the expected format

### Logs

The application logs important events to the console:
- API configuration status
- Panel detection results
- Narration generation progress
- Error messages and stack traces

## Development

### Running in Development Mode
```bash
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

### Adding New Detection Methods

1. Add your detection logic to `main.py`
2. Update the detection pipeline in `run_panel_detector()`
3. Add configuration options to the environment variables
4. Update this README with usage instructions

## License

This project is open source. Please check individual dependencies for their respective licenses.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## Acknowledgments

- [DeepPanel](https://github.com/pedrovgs/DeepPanel) for U-Net segmentation approach
- [MagiV3](https://huggingface.co/ragavsachdeva/magiv3) for panel detection model
- Google Gemini for AI-powered narration generation