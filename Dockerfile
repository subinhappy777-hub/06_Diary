FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    T06_HOST=0.0.0.0 \
    T06_PORT=8000 \
    T06_DB_PATH=/app/data/t06.sqlite3
WORKDIR /app
COPY server.py ./server.py
COPY static ./static
COPY contracts ./contracts
RUN mkdir -p /app/data && useradd --system --uid 10001 --home-dir /app appuser \
    && chown -R appuser:appuser /app
USER appuser
EXPOSE 8000
VOLUME ["/app/data"]
CMD ["python", "server.py"]
