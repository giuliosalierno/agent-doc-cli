export PATH := $(HOME)/.local/bin:$(PATH)

.PHONY: install run clean dev

install:
	@command -v uv >/dev/null 2>&1 || { echo "uv is not installed. Installing uv..."; curl -LsSf https://astral.sh/uv/install.sh | sh; }
	uv sync

run:
	uv run adk web . --port 8501 --reload_agents

dev:
	uv run python server.py

clean:
	rm -rf .venv __pycache__ app/__pycache__ app/tools/__pycache__
