SHELL := /bin/bash
PROJECT_ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
JAVA_21_HOME ?= /opt/homebrew/opt/openjdk@21
ANDROID_SDK_ROOT ?= /Users/irfanali/Library/Android/sdk

.PHONY: bootstrap verify ios android web api test-native test-web package-all clean

bootstrap:
	./scripts/bootstrap.sh

verify:
	./scripts/verify-toolchains.sh
	./scripts/lint-ios.sh
	pnpm verify
	$(MAKE) test-native

ios:
	./scripts/build-ios.sh

android:
	JAVA_HOME="$(JAVA_21_HOME)" ANDROID_SDK_ROOT="$(ANDROID_SDK_ROOT)" ./scripts/build-android.sh

web:
	pnpm --filter @rafay-pair/web build

api:
	pnpm --filter @rafay-pair/api build
	pnpm --filter @rafay-pair/worker build

test-native:
	./scripts/test-ios.sh
	JAVA_HOME="$(JAVA_21_HOME)" ANDROID_SDK_ROOT="$(ANDROID_SDK_ROOT)" ./scripts/test-android.sh

test-web:
	pnpm --filter @rafay-pair/web test
	pnpm --filter @rafay-pair/web test:e2e

package-all:
	./scripts/package-all.sh

clean:
	pnpm clean
	./apps/android/gradlew -p apps/android clean
	rm -rf artifacts reports
