SHELL := /bin/sh

ifneq ("$(wildcard .env)","")
include .env
export
endif

COMPOSE ?= docker compose
RELAY_URL ?= ws://127.0.0.1:8787

.PHONY: setup start up down logs daemon tunnel check build-libs

build-libs:
	npm run build:libs

setup:
	node scripts/setup.mjs

start: build-libs
	$(COMPOSE) --profile tunnel up --build -d relay pwa front-door
	$(COMPOSE) --profile tunnel up -d --force-recreate tunnel
	node scripts/start.mjs

up:
	$(COMPOSE) up --build -d relay pwa front-door
	@printf "\nArmorer Gauntlet is starting.\n"
	@printf "Local PWA:      http://127.0.0.1:%s\n" "$${FRONT_DOOR_PORT:-8080}"
	@printf "Local relay:    ws://127.0.0.1:%s\n" "$${RELAY_PORT:-8787}"
	@printf "Pair daemon:    make daemon\n\n"

down:
	$(COMPOSE) --profile tunnel down

logs:
	$(COMPOSE) --profile tunnel logs -f --tail=120

daemon: build-libs
	npm exec -w @armorer/gauntlet-daemon -- tsx src/index.ts start --relay "$(RELAY_URL)" --pair

tunnel: build-libs
	$(COMPOSE) --profile tunnel up --build -d relay pwa front-door
	$(COMPOSE) --profile tunnel up -d --force-recreate tunnel
	node scripts/print-tunnel.mjs

check:
	npm run check
	npm test
	npm run build
