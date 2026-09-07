FROM python:3.12-slim
WORKDIR /app
COPY backend/requirements.lock backend/requirements.lock
RUN pip install --no-cache-dir -r backend/requirements.lock
COPY backend backend
COPY ingestion ingestion
RUN useradd --uid 10001 --create-home appuser
USER appuser
EXPOSE 8000
CMD ["uvicorn", "backend.app.main:app", "--host", "0.0.0.0", "--port", "8000"]
