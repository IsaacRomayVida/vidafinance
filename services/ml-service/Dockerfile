FROM python:3.11-slim
WORKDIR /app
# curl for HEALTHCHECK; libgomp1 for LightGBM parallel processing
RUN apt-get update && apt-get install -y --no-install-recommends curl libgomp1 \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /models
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 3005
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:3005/health || exit 1
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "3005", "--workers", "2"]
