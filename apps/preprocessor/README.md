# Preprocessor service

Python sidecar for Hybrid Extraction v2.

## Local run

```bash
cd apps/preprocessor
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --host 127.0.0.1 --port 8010 --reload
```

## API

- `GET /health`
- `POST /prepass`
  - Input: `{ content: string, contentVersion: number }`
  - Output: `{ contentVersion, paragraphs, candidates, snippets }`
