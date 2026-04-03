FROM python:3.11-slim

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

COPY apps/preprocessor/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

COPY apps/preprocessor /app

EXPOSE 8010

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8010"]
