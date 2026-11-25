"""Persistencia del histórico en SQLite: lecturas y diagnósticos de IA.

Incluye exportación a CSV y solo usa la librería estándar.
"""

from __future__ import annotations

import csv
import os
import sqlite3
import threading
import time

# Ruta de la base de datos junto a este archivo (cps_ia/datacenter_historico.db).
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "datacenter_historico.db")

_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS lecturas (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    rack      TEXT    NOT NULL,
    metrica   TEXT    NOT NULL,
    valor     REAL,
    unidad    TEXT,
    source    TEXT,
    quality   TEXT
);
CREATE INDEX IF NOT EXISTS idx_lecturas_ts   ON lecturas(timestamp);
CREATE INDEX IF NOT EXISTS idx_lecturas_rack ON lecturas(rack, metrica);

CREATE TABLE IF NOT EXISTS diagnosticos (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp      INTEGER NOT NULL,
    rack           TEXT    NOT NULL,
    health_score   INTEGER,
    riesgo         TEXT,
    eta_alarma_seg REAL,
    anomalia       INTEGER,
    tendencia_c_min REAL,
    temp_actual    REAL,
    recomendacion  TEXT,
    source         TEXT,
    payload        TEXT
);
CREATE INDEX IF NOT EXISTS idx_diag_ts   ON diagnosticos(timestamp);
CREATE INDEX IF NOT EXISTS idx_diag_rack ON diagnosticos(rack);
"""


def _conectar() -> sqlite3.Connection:
    """Abre una conexión con WAL (rápida y segura ante lecturas concurrentes)."""
    conexion = sqlite3.connect(DB_PATH, timeout=10)
    conexion.execute("PRAGMA journal_mode=WAL;")
    conexion.execute("PRAGMA synchronous=NORMAL;")
    return conexion


def inicializar_db() -> None:
    """Crea las tablas e índices si no existen. Idempotente."""
    with _lock:
        conexion = _conectar()
        try:
            conexion.executescript(SCHEMA)
            conexion.commit()
        finally:
            conexion.close()


def registrar_lectura(
    rack: str,
    metrica: str,
    valor: float | None,
    unidad: str | None = None,
    source: str | None = None,
    quality: str | None = None,
    timestamp: float | None = None,
) -> None:
    """Inserta una lectura de sensor."""
    ts = int(timestamp if timestamp is not None else time.time() * 1000)

    with _lock:
        conexion = _conectar()
        try:
            conexion.execute(
                "INSERT INTO lecturas "
                "(timestamp, rack, metrica, valor, unidad, source, quality) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (ts, rack, metrica, valor, unidad, source, quality),
            )
            conexion.commit()
        finally:
            conexion.close()


def registrar_diagnostico(
    reporte: dict,
    source: str | None = "ia",
    payload: str | None = None,
) -> None:
    """Inserta un diagnóstico de IA a partir del reporte publicado por el motor."""
    ts = int(reporte.get("timestamp") or time.time() * 1000)
    rack = reporte.get("rack") or "desconocido"
    anomalia = reporte.get("anomalia")
    anomalia_int = None if anomalia is None else (1 if anomalia else 0)

    with _lock:
        conexion = _conectar()
        try:
            conexion.execute(
                "INSERT INTO diagnosticos "
                "(timestamp, rack, health_score, riesgo, eta_alarma_seg, anomalia, "
                " tendencia_c_min, temp_actual, recomendacion, source, payload) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    ts,
                    rack,
                    reporte.get("health_score"),
                    reporte.get("riesgo"),
                    reporte.get("eta_alarma_seg"),
                    anomalia_int,
                    reporte.get("tendencia_c_min"),
                    reporte.get("temp_actual"),
                    reporte.get("recomendacion"),
                    source,
                    payload,
                ),
            )
            conexion.commit()
        finally:
            conexion.close()


# Exportación a CSV

def _volcar_tabla(conexion: sqlite3.Connection, tabla: str, destino: str) -> int:
    cursor = conexion.execute(f"SELECT * FROM {tabla} ORDER BY timestamp ASC")
    columnas = [desc[0] for desc in cursor.description]
    filas = cursor.fetchall()

    with open(destino, "w", newline="", encoding="utf-8-sig") as archivo:
        escritor = csv.writer(archivo, delimiter=",", quoting=csv.QUOTE_MINIMAL)
        escritor.writerow(columnas)
        escritor.writerows(filas)

    return len(filas)


def exportar_csv(directorio: str | None = None) -> dict[str, str]:
    """
    Exporta las tablas `lecturas` y `diagnosticos` a CSV.

    Returns:
        dict con las rutas de los archivos generados y el número de filas.
    """
    destino = directorio or BASE_DIR
    os.makedirs(destino, exist_ok=True)

    ruta_lecturas = os.path.join(destino, "datacenter_lecturas.csv")
    ruta_diagnosticos = os.path.join(destino, "datacenter_diagnosticos.csv")

    with _lock:
        conexion = _conectar()
        try:
            n_lecturas = _volcar_tabla(conexion, "lecturas", ruta_lecturas)
            n_diag = _volcar_tabla(conexion, "diagnosticos", ruta_diagnosticos)
        finally:
            conexion.close()

    return {
        "lecturas_csv": ruta_lecturas,
        "lecturas_filas": n_lecturas,
        "diagnosticos_csv": ruta_diagnosticos,
        "diagnosticos_filas": n_diag,
    }


def resumen() -> dict[str, int]:
    """Cuenta las filas almacenadas (útil para verificar la persistencia)."""
    with _lock:
        conexion = _conectar()
        try:
            lecturas = conexion.execute("SELECT COUNT(*) FROM lecturas").fetchone()[0]
            diag = conexion.execute("SELECT COUNT(*) FROM diagnosticos").fetchone()[0]
        finally:
            conexion.close()
    return {"lecturas": lecturas, "diagnosticos": diag}


if __name__ == "__main__":
    inicializar_db()
    print(f"[DB] Base de datos lista: {DB_PATH}")
    print(f"[DB] Resumen: {resumen()}")
    print(f"[DB] Exportación: {exportar_csv()}")
