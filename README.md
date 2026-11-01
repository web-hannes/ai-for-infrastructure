# AI for Infrastructure

Coursework for **DIS – AI for Infrastructure** (WiSe 2026). Applies a CRISP-DM-style pipeline to drone-recorded intersection data, currently covering Data Understanding and Data Preparation. Modelling comes later.

**Scope:** motorised vehicles only (`car`, `truck_bus`). Pedestrians and cyclists are excluded per the project brief.

## Datasets

- **[inD](https://www.ind-dataset.com/)** — naturalistic drone recordings of road users at four German urban intersections. Place it in `inD-dataset-v1.1/data/`.
- **[highD](https://www.highd-dataset.com/)** — drone recordings of highway traffic on German motorways. Place it in `highD-dataset-v1.0/data/`. *(integration planned)*

Neither dataset is included in this repository.

## Notebooks

- `data-cleaning.ipynb` — flags and removes implausible vehicle tracks (short path, bounding-box outliers, teleportation); outputs `tracks_clean.csv`

## Outputs

| File | Description |
|---|---|
| `tracks_clean.csv` | Cleaned inD vehicle tracks, ready for feature engineering |

## Setup

```bash
uv sync
jupyter notebook
```

## Web Visualizations

```bash
python -m http.server
```

Then open http://localhost:8000/web-visualizations/.
