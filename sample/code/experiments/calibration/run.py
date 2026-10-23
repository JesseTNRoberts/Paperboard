"""Calibration experiment (demo). Writes SYNTHETIC metrics, not measurements."""
import csv, json, pathlib, random, sys, datetime

def main(run_id):
    cfg = {"seed": 20261012, "bands": ["0-40", "40-60", "60-80", "80-100"]}
    random.seed(cfg["seed"])
    out = pathlib.Path("results/calibration") / run_id
    out.mkdir(parents=True, exist_ok=True)
    with open(out / "metrics.csv", "w", newline="") as f:
        w = csv.writer(f); w.writerow(["humidity_band", "rmse_raw", "rmse_corrected"])
        for i, band in enumerate(cfg["bands"]):
            raw = 4 + 3 * i + random.random()
            w.writerow([band, round(raw, 2), round(raw * (0.75 - 0.08 * i), 2)])
    (out / "run.json").write_text(json.dumps({"run_id": run_id, "date": datetime.date.today().isoformat(), "config": cfg,
        "command": "make calibration", "note": "synthetic demo data"}, indent=2))

if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else datetime.date.today().isoformat() + "-a")
