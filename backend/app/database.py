"""Налаштування підключення до бази даних.

За замовчуванням використовується SQLite (файл arm.db поряд з backend),
щоб прототип запускався без зовнішніх залежностей. Для продакшену достатньо
вказати DATABASE_URL на PostgreSQL — решта коду не зміниться.
"""
import os

from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./arm.db")

# check_same_thread потрібен лише для SQLite
connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}

engine = create_engine(DATABASE_URL, connect_args=connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    """FastAPI-залежність: видає сесію БД на час запиту."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
