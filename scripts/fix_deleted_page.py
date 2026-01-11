import os
import sys
import json
import sqlite3
from typing import List, Dict, Any

# Add parent directory to path to allow importing mangaeditor
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from mangaeditor import EditorDB

def get_projects_with_mismatch():
    conn = EditorDB.conn()
    projects = conn.execute("SELECT id, title, pages_json FROM project_details").fetchall()
    
    mismatch_list = []
    
    for row in projects:
        pid, title, pages_json_str = row
        try:
            pages = json.loads(pages_json_str or "[]")
            num_pages = len(pages)
        except:
            num_pages = 0
            
        # Get max page_number from panels
        r = conn.execute("SELECT MAX(page_number), COUNT(DISTINCT page_number) FROM panels WHERE project_id=?", (pid,)).fetchone()
        max_panel_page = r[0] if r and r[0] is not None else 0
        distinct_panel_pages = r[1] if r and r[1] is not None else 0
        
        # Check for mismatch
        # We are looking for cases where panels exist for pages > num_pages
        # Specifically typical of "First Page Deleted" bug: 
        # num_pages = N, max_panel_page = N+1
        
        if max_panel_page > num_pages:
            mismatch_list.append({
                "id": pid,
                "title": title,
                "num_pages": num_pages,
                "max_panel_page": max_panel_page,
                "distinct_panel_pages": distinct_panel_pages
            })
            
    return mismatch_list

def fix_project(conn, pid, title):
    print(f"\n--- Fixing Project: {title} ({pid}) ---")
    print("⚠️  WARNING: This fix assumes the FIRST PAGE was deleted.")
    print("    It will DELETE panels for Page 1 and shift all others down.")
    
    try:
        # 1. Fetch all panels
        # columns: project_id, page_number, panel_index, image_path, narration_text, audio_url, created_at, updated_at, effect, transition, is_manual
        # We need to explicitly list columns to re-insert them correctly
        cols = "project_id, page_number, panel_index, image_path, narration_text, audio_url, created_at, updated_at, effect, transition, is_manual"
        rows = conn.execute(f"SELECT {cols} FROM panels WHERE project_id=? ORDER BY page_number ASC, panel_index ASC", (pid,)).fetchall()
        
        if not rows:
            print("No panels found.")
            return

        print(f"Found {len(rows)} panels. Rebuilding...")
        
        # 2. Delete all panels for this project
        conn.execute("DELETE FROM panels WHERE project_id=?", (pid,))
        
        # 3. Re-insert shifted
        skipped = 0
        inserted = 0
        
        for row in rows:
            # row index mapping based on cols string
            # 0: project_id, 1: page_number, ...
            p_num = row[1]
            
            if p_num == 1:
                skipped += 1
                continue
            
            # Shift page_number
            new_p_num = p_num - 1
            
            # Construct new tuple
            # We preserve everything else
            new_row = list(row)
            new_row[1] = new_p_num
            
            # Check is_manual handling (might be missing in older schemas, but our select asked for it)
            # If explicit column select failed, we'd crash earlier. 
            
            placeholders = ",".join(["?" for _ in new_row])
            conn.execute(f"INSERT INTO panels({cols}) VALUES({placeholders})", tuple(new_row))
            inserted += 1
            
        conn.commit()
        print(f"✅ Fixed: Removed {skipped} orphaned panels, Shifted {inserted} valid panels.")
        
    except Exception as e:
        print(f"❌ Error applying fix: {e}")
        conn.rollback()

def main():
    print("Scanning for projects with panel count mismatches...")
    mismatches = get_projects_with_mismatch()
    
    if not mismatches:
        print("No projects found with panel content exceeding page count.")
        return
        
    print(f"Found {len(mismatches)} potentially broken projects:")
    # Show first 10
    limit = 10
    for i, m in enumerate(mismatches[:limit]):
        print(f"{i+1}. {m['title']} (Pages: {m['num_pages']} | Panels Max: {m['max_panel_page']})")
    if len(mismatches) > limit:
        print(f"... and {len(mismatches) - limit} more.")
        
    val = input("\nEnter number to fix (or 'all', or 'q' to quit): ")
    if val.lower() == 'q':
        return
    
    conn = EditorDB.conn()
    
    if val.lower() == 'all':
        for m in mismatches:
            fix_project(conn, m['id'], m['title'])
    else:
        try:
            idx = int(val) - 1
            if 0 <= idx < len(mismatches):
                fix_project(conn, mismatches[idx]['id'], mismatches[idx]['title'])
            else:
                print("Invalid selection")
        except ValueError:
            print("Invalid input")


if __name__ == "__main__":
    main()
