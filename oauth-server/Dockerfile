FROM python:3.12-slim-bookworm
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
RUN mkdir -p /data/tokens
EXPOSE 8888
CMD ["gunicorn", "--bind", "0.0.0.0:8888", "--workers", "2", "--log-level", "info", "app:app"]
