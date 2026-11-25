import time
import torch
from chronos import Chronos2Pipeline

# Consola en UTF-8: en Windows cp1252 rompe al imprimir "°C" y emojis.
import sys

for _flujo in (sys.stdout, sys.stderr):
    try:
        _flujo.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

print("Cargando amazon/chronos-2 en RTX 3050...")
t0 = time.perf_counter()
pipeline = Chronos2Pipeline.from_pretrained(
    "amazon/chronos-2",
    device_map="cuda",
)
print(f"Modelo cargado en {time.perf_counter() - t0:.2f} s")
print(f"VRAM ocupada por el modelo: {torch.cuda.memory_allocated() / 1024**2:.1f} MB")

# Simulamos últimas 30 lecturas de temperatura de un rack subiendo hacia el umbral (30 °C)
historial_temp = [
    24.1, 24.2, 24.3, 24.5, 24.6, 24.8, 25.0, 25.1, 25.4, 25.6,
    25.9, 26.1, 26.3, 26.6, 26.8, 27.1, 27.3, 27.5, 27.8, 28.0,
    28.2, 28.4, 28.7, 28.9, 29.1, 29.2, 29.4, 29.5, 29.6, 29.8,
]
contexto = torch.tensor(historial_temp, dtype=torch.float32)

# Calentamiento (primera inferencia CUDA) + inferencia real
t1 = time.perf_counter()
quantiles, mean = pipeline.predict_quantiles(
    inputs=[contexto],
    prediction_length=12,           # próximos 12 pasos
    quantile_levels=[0.1, 0.5, 0.9] # banda inferior, mediana, banda superior
)
dt_ms = (time.perf_counter() - t1) * 1000

pred = quantiles[0].squeeze(0).cpu().numpy()  # forma: (12, 3) -> [p10, p50, p90]

print(f"\nInferencia completada en {dt_ms:.1f} ms")
print("Pronóstico próximos 12 pasos (umbral alarma web = 30.0 °C):")
for paso, (p10, p50, p90) in enumerate(pred, start=1):
    alerta = "⚠️ CRUZA 30°C" if p50 >= 30.0 else ""
    print(f"  +{paso:02d}: p10={p10:.2f}°C | p50={p50:.2f}°C | p90={p90:.2f}°C {alerta}")