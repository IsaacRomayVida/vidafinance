# Built from the monorepo repo root as context.
# Railway config: Root Directory = (unset), RAILWAY_DOCKERFILE_PATH = services/ml-service/Dockerfile
FROM python:3.11-slim
WORKDIR /app
RUN mkdir -p /models

COPY services/ml-service/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY services/ml-service/ ./

EXPOSE 3005
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:3005/health || exit 1
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "3005", "--workers", "2"]
