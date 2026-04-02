FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq-dev gcc \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Run as non-root for defense in depth.
RUN addgroup --system --gid 1001 visiban \
    && adduser --system --uid 1001 --ingroup visiban visiban \
    && chown -R visiban:visiban /app

USER visiban

EXPOSE 8000
