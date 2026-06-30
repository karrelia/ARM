"""Точка входу FastAPI-додатка АРМ Теплооблік (MVP)."""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .database import Base, engine
from .routers import houses, readings

app = FastAPI(
    title="АРМ Теплооблік — API",
    description="Облік відпущеної теплової енергії по будинках (прототип MVP).",
    version="0.1.0",
)

# Для розробки дозволяємо звернення з dev-сервера Vite.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup():
    # Створюємо таблиці, якщо їх ще немає (для SQLite-прототипу).
    Base.metadata.create_all(bind=engine)


@app.get("/api/health")
def health():
    return {"status": "ok"}


app.include_router(houses.router)
app.include_router(readings.router)
