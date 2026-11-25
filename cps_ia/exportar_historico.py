"""Exporta el histórico SQLite a CSV.

Uso:
    python cps_ia/exportar_historico.py [carpeta_destino]
"""

import os
import sys

# Permite `python cps_ia/exportar_historico.py` desde cualquier directorio.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import historico_db


def main() -> int:
    directorio = sys.argv[1] if len(sys.argv) > 1 else None

    historico_db.inicializar_db()

    print(f"[DB] Base de datos: {historico_db.DB_PATH}")
    conteo = historico_db.resumen()
    print(f"[DB] Registros -> lecturas: {conteo['lecturas']} | diagnósticos: {conteo['diagnosticos']}")

    if conteo["lecturas"] == 0 and conteo["diagnosticos"] == 0:
        print("[DB] No hay registros para exportar todavía.")
        return 0

    resultado = historico_db.exportar_csv(directorio)

    print(
        f"[CSV] Lecturas      -> {resultado['lecturas_csv']} "
        f"({resultado['lecturas_filas']} filas)"
    )
    print(
        f"[CSV] Diagnósticos  -> {resultado['diagnosticos_csv']} "
        f"({resultado['diagnosticos_filas']} filas)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
