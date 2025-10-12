import sqlite3
import json

conn = sqlite3.connect('data/mangaeditor.db')
cursor = conn.cursor()

print('=== TABLES ===')
tables = cursor.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
print([t[0] for t in tables])

print('\n=== PROJECT_DETAILS SCHEMA ===')
schema = cursor.execute('PRAGMA table_info(project_details)').fetchall()
for s in schema:
    print(s)

print('\n=== CURRENT PROJECTS ===')
projects = cursor.execute('SELECT id, title, created_at FROM project_details ORDER BY created_at DESC LIMIT 10').fetchall()
for p in projects:
    print(f'ID: {p[0]}, Title: {p[1]}, Created: {p[2]}')

print('\n=== SAMURAI PROJECT DETAILS ===')
samurai = cursor.execute("SELECT * FROM project_details WHERE title LIKE '%Samurai%' OR title LIKE '%samurai%'").fetchall()
if samurai:
    for row in samurai:
        print(f'\nID: {row[0]}')
        print(f'Title: {row[1]}')
        print(f'Created: {row[2]}')
        print(f'Pages: {row[3][:100]}...' if len(row[3]) > 100 else f'Pages: {row[3]}')
        print(f'Character MD length: {len(row[4])}')
        if len(row) > 5:
            print(f'Story Summary length: {len(row[5]) if row[5] else 0}')

conn.close()
