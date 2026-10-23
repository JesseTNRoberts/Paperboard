"""Figure: calibration error by humidity band (demo; SYNTHETIC data).
Reads results/calibration/2026-10-12-a/metrics.csv, writes figures/calibration_error.pdf and .png."""
import csv
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

RUN = "results/calibration/2026-10-12-a/metrics.csv"
rows = list(csv.DictReader(open(RUN)))
bands = [r["humidity_band"] for r in rows]
x = range(len(bands))
plt.rcParams.update({"figure.figsize": (6, 3.6), "axes.spines.top": False, "axes.spines.right": False, "font.size": 10})
fig, ax = plt.subplots()
ax.bar([i - 0.2 for i in x], [float(r["rmse_raw"]) for r in rows], width=0.4, label="Raw", color="#9aa7ab")
ax.bar([i + 0.2 for i in x], [float(r["rmse_corrected"]) for r in rows], width=0.4, label="Corrected", color="#2b6e8f")
ax.set_xticks(list(x), [b + "%" for b in bands])
ax.set_xlabel("Relative humidity"); ax.set_ylabel("RMSE (µg/m³)")
ax.set_title("Synthetic demo data", fontsize=9, color="#b02a4a", loc="right")
ax.legend(frameon=False)
fig.tight_layout()
for ext in ("pdf", "png"):
    fig.savefig(f"figures/calibration_error.{ext}", dpi=200)
