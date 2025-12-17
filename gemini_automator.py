
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
        input_selector = "div[contenteditable='true'][role='textbox']"
        
        # Check for login
        try:
            page.wait_for_selector(input_selector, timeout=15000)
        except:
            raise Exception("Please Log In to Gemini in the Chrome window.")

        # Upload Images
        if image_paths:
            logger.info(f"Uploading {len(image_paths)} images...")
            import subprocess
            
            input_box = page.wait_for_selector(input_selector)
            input_box.click()
            
            for i, img_path in enumerate(image_paths):
                try:
                    abs_path = os.path.abspath(img_path)
                    # PowerShell copy
                    ps_script = f"Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::SetImage([System.Drawing.Image]::FromFile('{abs_path}'))"
                    subprocess.run(["powershell", "-Command", ps_script], check=True, capture_output=True)
                    
                    input_box.focus()
                    page.keyboard.press("Control+V")
                    time.sleep(3) 
                except Exception as e:
                    logger.error(f"Failed to paste image {img_path}: {e}")
                    # Fallback
                    try:
                        subprocess.run(["powershell", "-Command", f"Set-Clipboard -Path '{abs_path}'"], check=True)
                        input_box.focus()
                        page.keyboard.press("Control+V")
                        time.sleep(3)
                    except:
                        pass
            time.sleep(2)

        # Enter Prompt
        logger.info("Entering prompt...")
        
        # Count existing
        existing_responses_count = 0
        try:
            existing = page.query_selector_all(".markdown")
            existing_responses_count = len(existing) if existing else 0
        except:
            pass
        
        input_box = page.wait_for_selector(input_selector)
        input_box.fill(prompt)
        time.sleep(1)
        
        # Send
        send_button = page.query_selector("button[aria-label*='Send'], button[class*='send-button']")
        if not send_button:
             input_box.press("Enter")
        else:
            send_button.click()
        
        logger.info("Waiting for new response...")
        
        # Wait for new
        max_wait_start = 60
        new_response_found = False
        for _ in range(max_wait_start):
            time.sleep(1)
            current_responses = page.query_selector_all(".markdown")
            if len(current_responses) > existing_responses_count:
                new_response_found = True
                break
        
        if not new_response_found:
            logger.warning("No new response detected? Trying to capture last element anyway...")

        logger.info("Stabilizing response...")

        # Stabilize
        last_text = ""
        stable_count = 0
        max_retries = 120 
        
        for i in range(max_retries):
            time.sleep(1)
            responses = page.query_selector_all(".markdown")
            if not responses: continue
                
            current_text = responses[-1].inner_text()
            if not current_text: continue
            
            if current_text == last_text and len(current_text) > 10:
                stable_count += 1
                if stable_count >= 3:
                    return current_text
            else:
                stable_count = 0
                last_text = current_text
        
        return last_text

if __name__ == "__main__":
    # Test stub
    automator = GeminiAutomator()
    # automator.start_session(new_tab=True)


