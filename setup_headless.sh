#!/bin/bash
echo "========================================"
echo "  Headless Recording Setup"
echo "========================================"
echo ""

echo "Installing Playwright and dependencies..."
pip install playwright playwright-stealth

echo ""
echo "Installing Chromium browser..."
playwright install chromium

echo ""
echo "========================================"
echo "  Installation Complete!"
echo "========================================"
echo ""
echo "You can now use the 'Headless Render (Audio)' button"
echo "in the video editor to record with full audio support."
echo ""
