# Series-Level Narration Generation Logic

This document explains the current implementation of narration generation for manga series in the codebase.

## Overview

The narration generation process is designed to be **context-aware** across a series. It ensures that the narration for a specific chapter takes into account the "story so far" and the established character list from previous chapters. It also dynamically updates the series-level character list and story summaries as new narrations are generated.

## Workflow

### 1. Series-Level Orchestration
**Endpoint:** `POST /api/manga/series/{series_id}/narrate-all`
**Function:** `api_narrate_all_series_chapters_execute` in `mangaeditor.py`

This is the main entry point for generating narrations for an entire series.

1.  **Fetch Series & Chapters:** Retrieves the series metadata and list of chapters.
2.  **Filter:** Identifies chapters that need narration (skips those that already have non-empty narration text).
3.  **Iterate & Validate:** Loops through each chapter to process, ensuring it has pages and panels created.
4.  **Context Retrieval:** Fetches the **Series Character List** (`EditorDB.get_series_character_list`). This list is passed to the chapter generation function to ensure consistent character naming.
5.  **Execution:** Calls the chapter-level generation function (`api_narrate_sequential`) for each chapter sequentially.

### 2. Chapter-Level Generation
**Endpoint:** `POST /api/project/{project_id}/narrate/sequential`
**Function:** `api_narrate_sequential` in `mangaeditor.py`

This function generates narration for a single chapter (project), page by page.

1.  **Context Setup:**
    *   Checks if the project belongs to a series.
    *   Retrieves **Accumulated Context** from previous chapters (`EditorDB.get_previous_chapters_context`). This includes:
        *   **Story Summary:** A summary of all previous chapters ("Story So Far").
        *   **Character List:** If the current chapter has no character list, it inherits the one from previous chapters.
    *   Initializes `accumulated_text` with this previous context.

2.  **Page-by-Page Generation:**
    *   Iterates through each page of the chapter.
    *   **Prompt Construction** (`_build_page_prompt`):
        *   Combines system instructions ("You are a manga narration assistant...").
        *   Appends `accumulated_context` (summaries of previous chapters + narration of previous pages in current chapter).
        *   Appends `user_characters` (markdown list of characters).
        *   Attaches panel images for the current page.
    *   **AI Call:** Sends the prompt to **Gemini** (`gemini-2.5-flash` or configured model).
    *   **Processing:**
        *   Parses the JSON response (list of panel narrations).
        *   Upserts the text into the database (`EditorDB.upsert_panel_narration`).
        *   Updates `accumulated_text` with the newly generated narration for the next page's context.

### 3. Post-Generation Updates (Auto-Learning)
After generating narrations for a chapter, the system performs "auto-learning" to update the series context:

1.  **Generate Character List:**
    *   Feeds all generated panel narrations for the chapter back to Gemini.
    *   Prompts it to create a comprehensive **Character List** in Markdown.
    *   **Propagation:** Saves this list to the current chapter AND **propagates it to the Series** and all other chapters (`EditorDB.set_series_character_list`, `EditorDB.propagate_character_list_to_chapters`). This ensures future chapters use the updated roster.

2.  **Generate Story Summary:**
    *   Feeds the narrations to Gemini again.
    *   Prompts it to write a **"Story So Far" summary**.
    *   Saves this summary to the database. This summary will be used as context for the *next* chapter in the series.

## Key Components

### Database (`EditorDB`)
*   `get_series_character_list(series_id)`: Retrieves the master character list.
*   `get_previous_chapters_context(series_id, current_chapter)`: Crucial for continuity. Fetches the summary of chapters `1` to `current_chapter - 1`.
*   `propagate_character_list_to_chapters(series_id, markdown)`: Syncs the character list across the series.

### Prompt Engineering (`_build_page_prompt`)
*   **Role:** "Manga narration assistant".
*   **Style:** "Vivid, short sentence per panel", "Connects naturally", "Avoid list formatting".
*   **Constraints:** "Return ONLY JSON".
*   **Context Injection:** Previous pages and chapters are injected to maintain narrative flow.

### AI Model
*   **Provider:** Google Gemini (via `google.generativeai`).
*   **Model:** Defaults to `gemini-2.5-flash` (configurable via env `GEMINI_MODEL`).
