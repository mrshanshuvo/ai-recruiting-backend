#!/usr/bin/env bash
set -e

echo "================================================================================"
echo "AI Recruiting Co-Worker - Preflight System Readiness Verification"
echo "================================================================================"

FAILURES=0

# 1. API Health Check
echo -n "[1/7] Checking API health endpoint (http://localhost:4000/health)... "
if curl -sf http://localhost:4000/health > /dev/null 2>&1; then
  echo "OK"
else
  echo "FAILED (API not responding at http://localhost:4000/health)"
  FAILURES=$((FAILURES + 1))
fi

# 2. Worker Running Check
echo -n "[2/7] Checking background queue worker process... "
if docker ps --filter "name=recruiting_worker" --filter "status=running" --format "{{.Names}}" | grep -q "recruiting_worker"; then
  echo "OK (recruiting_worker container is running)"
elif pgrep -f "index.worker" > /dev/null 2>&1; then
  echo "OK (local worker process running)"
else
  echo "FAILED (No background worker running)"
  FAILURES=$((FAILURES + 1))
fi

# 3. Redis Ping Check
echo -n "[3/7] Checking Redis connection (PONG)... "
REDIS_RES=$(docker exec recruiting_redis redis-cli ping 2>/dev/null || redis-cli ping 2>/dev/null || true)
if [ "$REDIS_RES" = "PONG" ]; then
  echo "OK (PONG)"
else
  echo "FAILED (Redis not reachable or did not respond with PONG)"
  FAILURES=$((FAILURES + 1))
fi

# 4. MongoDB Ping Check
echo -n "[4/7] Checking MongoDB connection (adminCommand ping)... "
MONGO_RES=$(docker exec recruiting_mongo mongosh --eval "db.adminCommand('ping').ok" --quiet 2>/dev/null || true)
if echo "$MONGO_RES" | grep -q "1"; then
  echo "OK (ok: 1)"
else
  echo "FAILED (MongoDB not reachable or ping failed)"
  FAILURES=$((FAILURES + 1))
fi

# 5. GEMINI_API_KEY Check
echo -n "[5/7] Checking GEMINI_API_KEY configuration... "
API_KEY="${GEMINI_API_KEY}"
if [ -z "$API_KEY" ]; then
  if [ -f ".env" ]; then
    API_KEY=$(grep "^GEMINI_API_KEY=" .env | cut -d= -f2 | tr -d '"' | tr -d "'")
  elif [ -f "apps/backend/.env" ]; then
    API_KEY=$(grep "^GEMINI_API_KEY=" apps/backend/.env | cut -d= -f2 | tr -d '"' | tr -d "'")
  fi
fi
if [ -n "$API_KEY" ]; then
  echo "OK (Present, ${#API_KEY} characters)"
else
  echo "FAILED (GEMINI_API_KEY is unset in environment and apps/backend/.env)"
  FAILURES=$((FAILURES + 1))
fi

# 6. Model in ListModels Check
echo -n "[6/7] Checking LLM model availability via Gemini ListModels API... "
TARGET_MODEL="gemini-3.1-flash-lite"
if [ -n "$API_KEY" ]; then
  MODELS_JSON=$(curl -s "https://generativelanguage.googleapis.com/v1beta/models?key=${API_KEY}")
  if echo "$MODELS_JSON" | grep -q "models/${TARGET_MODEL}"; then
    echo "OK (models/${TARGET_MODEL} verified in ListModels)"
  else
    echo "FAILED (Model ${TARGET_MODEL} not found in ListModels API response)"
    FAILURES=$((FAILURES + 1))
  fi
else
  echo "SKIPPED (No API key)"
  FAILURES=$((FAILURES + 1))
fi

# 7. Ethereal DNS Resolution Check
echo -n "[7/7] Checking ethereal.email DNS resolution... "
if getent hosts ethereal.email > /dev/null 2>&1 || host ethereal.email > /dev/null 2>&1 || nslookup ethereal.email > /dev/null 2>&1; then
  ETH_IP=$(getent hosts ethereal.email | awk '{print $1}' | head -n 1)
  echo "OK (Resolved to ${ETH_IP:-available})"
else
  echo "FAILED (Could not resolve ethereal.email DNS)"
  FAILURES=$((FAILURES + 1))
fi

echo "================================================================================"
if [ $FAILURES -eq 0 ]; then
  echo "PREFLIGHT PASSED: All 7 system dependencies and services are verified operational."
  exit 0
else
  echo "PREFLIGHT FAILED: ${FAILURES} checks failed. Resolve errors before proceeding."
  exit 1
fi

