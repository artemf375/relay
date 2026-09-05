.PHONY: install test typecheck build ios-project ios-test docker-build backup-once

install:
	pnpm install

test:
	pnpm test
	cd ios && SWIFTPM_MODULECACHE_OVERRIDE=/tmp/relay-swift-module-cache CLANG_MODULE_CACHE_PATH=/tmp/relay-clang-module-cache swift test --disable-sandbox

typecheck:
	pnpm typecheck

build:
	pnpm build

ios-project:
	cd ios && xcodegen generate

ios-test:
	cd ios && SWIFTPM_MODULECACHE_OVERRIDE=/tmp/relay-swift-module-cache CLANG_MODULE_CACHE_PATH=/tmp/relay-clang-module-cache swift test --disable-sandbox

docker-build:
	docker build --platform linux/arm64 -t relay:local .

backup-once:
	docker compose run --rm -e BACKUP_ONCE=1 backup
