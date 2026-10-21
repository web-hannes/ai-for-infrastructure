# AI for Infrastructure

Exploratory analysis of the [inD dataset](https://www.ind-dataset.com/) — a naturalistic drone-recorded dataset of road users at German intersections.

## Contents

- `data-understanding.ipynb` — data exploration and visualization
- `web-visualizations/` — interactive browser-based visualizations
- `docs/` — dataset format documentation

## Setup

Requires the inD dataset (not included). Place it in `inD-dataset-v1.1/data/`.

```bash
uv sync
jupyter notebook
```

## Web Visualizations

```bash
python -m http.server
```

Then open http://localhost:8000/web-visualizations/.
