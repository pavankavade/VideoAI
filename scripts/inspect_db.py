import os
import sqlite3
import json
from datetime import datetime

def main():
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    db_path = os.path.join(base_dir, 'data', 'mangaeditor.db')

    print('=== DB INSPECT ===')
    print(f"Base dir: {base_dir}")
    print(f"DB path:  {db_path}")

    if not os.path.exists(db_path):
        print('Database not found. Expected at:', db_path)
        return

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    try:
        cur = conn.cursor()

        # List tables
        tables = [r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()]
        print(f"Tables ({len(tables)}):", tables)
        print()

        for t in tables:
            print('=' * 80)
            print(f"Table: {t}")

            # Schema
            print('- Schema:')
            cols = cur.execute(f"PRAGMA table_info({t})").fetchall()
            for c in cols:
                # PRAGMA table_info columns: cid, name, type, notnull, dflt_value, pk
                print(f"  - {c['name']} {c['type']} {'NOT NULL' if c['notnull'] else ''} {'PK' if c['pk'] else ''}")

            # Count
            count = cur.execute(f"SELECT COUNT(*) AS c FROM {t}").fetchone()[0]
            print(f"- Row count: {count}")

            # Sample rows
            limit = 25
            # Prefer ordering by a timestamp column if present
            col_names = {c['name'] for c in cols}
            order_col = None
            for cand in ("updated_at", "created_at", "createdAt", "created", "ts"):
                if cand in col_names:
                    order_col = cand
                    break

            rows = []
            order_info = None
            if order_col:
                try:
                    rows = cur.execute(f"SELECT * FROM {t} ORDER BY {order_col} DESC LIMIT {limit}").fetchall()
                    order_info = f"ordered by {order_col} DESC"
                except Exception:
                    rows = []
            if not rows:
                # Fallback: try rowid DESC (newest inserts first)
                try:
                    rows = cur.execute(f"SELECT * FROM {t} ORDER BY rowid DESC LIMIT {limit}").fetchall()
                    order_info = "ordered by rowid DESC"
                except Exception:
                    # Final fallback: no ordering
                    rows = cur.execute(f"SELECT * FROM {t} LIMIT {limit}").fetchall()
                    order_info = None

            if order_info:
                print(f"- Showing up to {limit} rows ({order_info}):")
            else:
                print(f"- Showing up to {limit} rows:")
            for r in rows:
                # Convert Row to dict, try to pretty-print JSON fields
                d = {k: r[k] for k in r.keys()}
                # Best-effort JSON pretty for known JSON text columns
                for key in ('pages_json', 'metadata_json'):
                    if key in d and isinstance(d[key], str):
                        try:
                            d[key] = json.dumps(json.loads(d[key]), indent=2, ensure_ascii=False)
                        except Exception:
                            pass
                print(json.dumps(d, ensure_ascii=False, indent=2))
            if count > limit:
                print(f"... ({count - limit} more rows not shown)")

        print('=' * 80)
        print('Completed at', datetime.utcnow().isoformat() + 'Z')

    finally:
        conn.close()

if __name__ == '__main__':
    main()
