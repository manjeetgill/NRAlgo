FROM python:3.14-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt && groupadd --gid 10001 nexus && useradd --uid 10001 --gid nexus --no-create-home nexus
COPY backend ./backend
COPY alembic.ini ./
RUN mkdir /app/.runtime && chown nexus:nexus /app/.runtime
USER nexus
EXPOSE 8000
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
