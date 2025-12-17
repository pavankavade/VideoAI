
import os

MANGA_EDITOR_PATH = r"c:\Users\Pavan\Documents\git\videoai\mangaeditor.py"

MISSING_CODE = r'''

# --- Automation Endpoints ---

@router.get("/api/project/{project_id:path}/story")
async def api_get_story_summary(project_id: str):
    """Get the current story summary."""
    summary = EditorDB.get_story_summary(project_id) or ""
    return {"summary": summary}
    
@router.post("/api/auth/gemini-web")
async def api_auth_gemini_web():
    """
    Triggers the login mode for Gemini Web automation.
    Launches a browser window for the user to log in.
    """
    try:
        if GeminiAutomator is None:
             # Ensure import worked or try lazily?
             from gemini_automator import GeminiAutomator as GA
             automator = GA()
        else:
             automator = GeminiAutomator()
             
        # Run in a separate thread/task so we don't block API? 
        # Actually login_mode is async, but it waits for user close.
        await automator.login_mode()
        return {"ok": True, "message": "Login window closed. Session saved."}
    except Exception as e:
        print(f"Login failed: {e}")
        # If import failed
        if "GeminiAutomator" in str(e) or "name 'GeminiAutomator' is not defined" in str(e):
             from gemini_automator import GeminiAutomator
             await GeminiAutomator().login_mode()
             return {"ok": True}
             
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/api/project/{project_id:path}/narrate/page/{page_number}/auto-web")
async def api_narrate_auto_web(project_id: str, page_number: int, payload: Dict[str, Any]):
    """
    Automates the "Manual" workflow using Playwright.
    """
    # Just in case import is missing in scope
    try:
        if 'GeminiAutomator' not in globals() and 'GeminiAutomator' not in locals():
            from gemini_automator import GeminiAutomator
    except:
        from gemini_automator import GeminiAutomator

    # 1. Fetch Panels/Images
    panels = EditorDB.get_panels_for_page(project_id, page_number)
    if not panels:
        raise HTTPException(status_code=404, detail="No panels found for this page")
        
    image_paths = []
    
    # Need generic base dir logic matching global MANGA_BASE_DIR
    # We will assume global is available or redefine valid logic
    BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "manga_projects")
    if 'MANGA_BASE_DIR' in globals():
        BASE = MANGA_BASE_DIR
        
    for p in panels:
        # Resolve URL to local path
        rel_path = p.get('image', '').replace('/manga_projects/', '')
        if '?' in rel_path:
            rel_path = rel_path.split('?')[0]
            
        full_path = Path(BASE) / rel_path
        if full_path.exists():
            image_paths.append(str(full_path.absolute()))
        else:
            # Try absolute match if it was stored differently
            pass
            
    if not image_paths:
         raise HTTPException(status_code=400, detail="Could not locate image files on disk")

    # 2. Build Prompt
    context = payload.get('context', '')
    character_list = payload.get('characterList', '')
    
    prompt = f"""You are a professional manga narrator.
    
TASK: Write a narration script for the attached manga page images (Panels 1 to {len(panels)}).
STORY CONTEXT: {context}
CHARACTERS: {character_list}

REQUIREMENTS:
1. Output JSON ONLY.
2. Format: {{ "panels": [ {{ "panel_index": 1, "text": "..." }}, ... ] }}
3. One narration text per panel.
4. Use the visual details in the images + the context text.
5. Do not output markdown code blocks, just the raw JSON.
"""

    # 3. Call Automator
    try:
        automator = GeminiAutomator()
        response_text = await automator.generate_content(prompt, image_paths)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Automation failed: {str(e)}")

    # 4. Parse Response
    clean_text = response_text.strip()
    if clean_text.startswith("```"):
        clean_text = clean_text.split("\n", 1)[-1]
        clean_text = clean_text.rsplit("\n", 1)[0]
    
    clean_text = clean_text.replace("```json", "").replace("```", "").strip()
    
    try:
        data = json.loads(clean_text)
        new_panels = data.get("panels", [])
        
        # 5. Save Results
        if new_panels:
             EditorDB.save_manual_narration(project_id, page_number, new_panels)
             return {"ok": True, "panels": new_panels}
        else:
             raise ValueError("No 'panels' key in response")
             
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to parse JSON response: {e}. raw: {clean_text[:50]}...")
'''

with open(MANGA_EDITOR_PATH, 'r', encoding='utf-8') as f:
    content = f.read()

# Check and patch
if "async def api_auth_gemini_web" not in content:
    print("Appending api_auth_gemini_web...")
    content += MISSING_CODE
else:
    print("api_auth_gemini_web already present.")

# Fix provider check
if 'if provider not in ("gemini", "groq", "azure", "manual_web")' in content:
    print("Fixing provider validation...")
    content = content.replace(
        'if provider not in ("gemini", "groq", "azure", "manual_web")',
        'if provider not in ("gemini", "groq", "azure", "manual_web", "manual_web", "auto_web")'
    )

with open(MANGA_EDITOR_PATH, 'w', encoding='utf-8') as f:
    f.write(content)

print("Done patching.")
