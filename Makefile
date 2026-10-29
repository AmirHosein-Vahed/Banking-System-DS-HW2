SHELL := /bin/bash
COMPOSE := docker compose -f deploy/compose.yaml

.PHONY: up down reset logs ps build test test-integration typecheck lint bootstrap cli exp1 exp2 exp3 exp4 exp5 exp6 exp7 exp-all

up:
	$(COMPOSE) up -d --build

down:
	$(COMPOSE) down

reset:
	$(COMPOSE) down -v
	$(COMPOSE) up -d --build

logs:
	$(COMPOSE) logs -f

ps:
	$(COMPOSE) ps

build:
	npm run build

typecheck:
	npm run typecheck

test:
	npm test

test-integration:
	npm run test:integration

lint:
	npm run lint

bootstrap:
	$(COMPOSE) run --rm bootstrap

cli:
	$(COMPOSE) run --rm client $(ARGS)

exp1:
	bash scripts/experiments/01-shard-distribution.sh

exp2:
	bash scripts/experiments/02-replica-distribution.sh

exp3:
	bash scripts/experiments/03-concurrent-clients.sh

exp4:
	bash scripts/experiments/04-replica-failover.sh

exp5:
	bash scripts/experiments/05-transfers.sh

exp6:
	bash scripts/experiments/06-coordinator-recovery.sh

exp7:
	bash scripts/experiments/07-concurrent-transfers.sh

exp-all:
	bash scripts/experiments/run-all.sh
