
import os
import time
import logging
import json
from pathlib import Path
from typing import List, Optional, Dict, Any

from playwright.sync_api import sync_playwright, BrowserContext, Page, ElementHandle

logger = logging.getLogger("gemini_automator")
logger.setLevel(logging.INFO)

class GeminiAutomator:
    """
    Automates interactions with Gemini Web UI (gemini.google.com) using Playwright.
    Connects to an EXISTING Chrome instance running with --remote-debugging-port=9222.
    This bypasses login/bot detection by using the user's manual session.
    """
    
    def __init__(self, user_data_dir: str = None):
        self.cdp_url = "http://localhost:9222"
        # user_data_dir is now managed by the external Chrome process
        self.playwright = None
        self.browser = None
        self.context = None
        self.page = None
        self._session_active = False

    def start_session(self, new_tab: bool = False):
        """Starts a persistent session (context manager compatible)."""
        logger.info(f"Starting Gemini session (New Tab: {new_tab})...")
        self.playwright = sync_playwright().start()
        try:
            self.browser = self.playwright.chromium.connect_over_cdp(self.cdp_url)
            if not self.browser.contexts:
                self.context = self.browser.new_context()
            else:
                self.context = self.browser.contexts[0]
            
            if new_tab:
                logger.info("Session: Creating new tab...")
                self.page = self.context.new_page()
            else:
                # Find existing
                found = False
                for pg in reversed(self.context.pages):
                     if "gemini.google.com" in pg.url:
                         self.page = pg
                         found = True
                         break
                if not found:
                    self.page = self.context.new_page()
            
            self.page.bring_to_front()
            
            # Navigate if needed
            if "gemini.google.com" not in self.page.url or "app" not in self.page.url:
                 logger.info("Session: Navigating to Gemini...")
                 self.page.goto("https://gemini.google.com/app", wait_until="domcontentloaded", timeout=60000)
            
            self._session_active = True
            return self
        except Exception as e:
            self.close_session()
            raise e

    def close_session(self):
        """Closes the session and disconnects."""
        logger.info("Closing Gemini session...")
        if self.browser:
            try:
                self.browser.close()
            except:
                pass
        if self.playwright:
            try:
                self.playwright.stop()
            except:
                pass
        self.playwright = None
        self.browser = None
        self.context = None
        self.page = None
        self._session_active = False

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close_session()

    def generate_content(self, prompt: str, image_paths: List[str] = None, new_tab: bool = False) -> str:
        """
        Generates content. Uses existing session if active, otherwise ephemeral connection.
        """
        if image_paths is None:
            image_paths = []
            
        # If session is active, use it
        if self._session_active and self.page:
            return self._run_generation_on_page(self.page, prompt, image_paths)
        
        # Fallback to ephemeral (one-off) logic
        logger.info(f"Starting one-off generation (CDP) with {len(image_paths)} images... (New Tab: {new_tab})")
        with sync_playwright() as p:
            browser = p.chromium.connect_over_cdp(self.cdp_url)
            context = browser.contexts[0] if browser.contexts else browser.new_context()
            
            page = None
            if new_tab:
                page = context.new_page()
            else:
                found = False
                for pg in reversed(context.pages):
                    if "gemini.google.com" in pg.url:
                        page = pg
                        found = True
                        break
                if not page:
                     page = context.new_page()
            
            page.bring_to_front()
            if "gemini.google.com" not in page.url:
                 page.goto("https://gemini.google.com/app", wait_until="domcontentloaded", timeout=60000)
            
            try:
                result = self._run_generation_on_page(page, prompt, image_paths)
                browser.close()
                return result
            except Exception as e:
                browser.close()
                raise e

    def _run_generation_on_page(self, page: Page, prompt: str, image_paths: List[str]) -> str:
        """Internal worker logic to run prompt on a specific page object."""
        # Selector for the rich input editor
        input_selector = "div[contenteditable='true'][role='textbox']"
        
        # 1. Check for login / Wait for Input
        try:
            page.wait_for_selector(input_selector, timeout=15000)
        except:
            raise Exception("Please Log In to Gemini in the Chrome window.")

        # 2. Ensure we are ready (Wait for ANY previous generation to finish)
        logger.info("Waiting for previous generation to complete...")
        try:
            # "Stop response" button should be hidden/detached when idle.
            page.wait_for_selector("button[aria-label='Stop response']", state="hidden", timeout=30000)
        except Exception as e:
            logger.warning(f"Stop button still visible? potentially stuck. Proceeding anyway, but this is risky: {e}") 
        
        # 3. Clear Input (Critical to avoid appending to failed retries)
        logger.info("Clearing input...")
        input_box = page.wait_for_selector(input_selector)
        input_box.click()
        # Select all and delete to be sure
        page.keyboard.press("Control+A")
        time.sleep(0.5)
        page.keyboard.press("Backspace")
        time.sleep(0.5)

        # 4. Fill Prompt TEXT FIRST
        # Why? Because .fill() clears the element. If we pasted images first, .fill() would delete them!
        logger.info("Entering prompt...")
        input_box.fill(prompt)
        time.sleep(1)
        
        # 5. Upload Images (Clipboard Paste)
        if image_paths:
            logger.info(f"Uploading {len(image_paths)} images...")
            import subprocess
            
            # Ensure focus is back on input (at the end of text)
            input_box.focus()
            page.keyboard.press("End") 
            
            for i, img_path in enumerate(image_paths):
                try:
                    abs_path = os.path.abspath(img_path)
                    # PowerShell to set clipboard
                    # Note: Add-Type approach is standard for Windows
                    ps_script = f"Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::SetImage([System.Drawing.Image]::FromFile('{abs_path}'))"
                    subprocess.run(["powershell", "-Command", ps_script], check=True, capture_output=True)
                    
                    # Focus and Paste
                    input_box.focus() 
                    time.sleep(0.5)
                    page.keyboard.press("Control+V")
                    
                    # Wait for image thumbnail to potentially appear or just give it a moment
                    # We can't easily detect the thumbnail upload progress without complex selectors, 
                    # so a fixed sleep is safer than nothing.
                    time.sleep(2.5) 
                except Exception as e:
                    logger.error(f"Failed to paste image {img_path}: {e}")
                    # Fallback method
                    try:
                        subprocess.run(["powershell", "-Command", f"Set-Clipboard -Path '{abs_path}'"], check=True)
                        input_box.focus()
                        page.keyboard.press("Control+V")
                        time.sleep(2.5)
                    except:
                        pass
        
        # 6. Capture State Before Sending
        existing_responses_count = 0
        try:
            existing = page.query_selector_all(".markdown")
            existing_responses_count = len(existing) if existing else 0
        except:
            pass

        # 7. Send Request
        logger.info("Sending message...")
        send_button = page.query_selector("button[aria-label='Send message']")
        if send_button:
            send_button.click()
        else:
            logger.info("Send button not found, using Enter...")
            input_box.focus()
            page.keyboard.press("Enter")
            
        # 8. Smart Wait for Completion
        logger.info("Waiting for response generation...")
        
        # Phase A: Wait for "Stop response" to APPEAR (Generation started)
        # This confirms the click worked.
        # Give it up to 10 seconds to start.
        try:
            page.wait_for_selector("button[aria-label='Stop response']", state="visible", timeout=10000)
            logger.info("Generation started (Stop button visible).")
        except:
            logger.warning("Stop button did NOT appear. Request might have failed or finished instantly.")

        # Phase B: Wait for "Stop response" to DISAPPEAR (Generation finished)
        # Give it a long timeout (e.g., 3-5 minutes for long image analysis)
        try:
            page.wait_for_selector("button[aria-label='Stop response']", state="hidden", timeout=300000) # 5 minutes
            logger.info("Generation finished (Stop button hidden).")
        except Exception as e:
            logger.error(f"Timed out waiting for generation to finish: {e}")
            # We continue and try to scrape whatever is there

        # Phase C: Scrape the latest response
        # We wait a moment for DOM to settle
        time.sleep(2)
        
        responses = page.query_selector_all(".markdown")
        if not responses:
             logger.warning("No .markdown elements found!")
             return ""
             
        # Return the last one
        last_response = responses[-1]
        text = last_response.inner_text()
        return text

if __name__ == "__main__":
    # Test stub
    automator = GeminiAutomator()
    # automator.start_session(new_tab=True)


