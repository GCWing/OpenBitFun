cmake_minimum_required(VERSION 3.16)
project(openbitfun_crypto)

# Argon2 is a shared, platform-neutral source set. HarmonyOS and the KMP iOS
# actual both build this same implementation; keep the algorithm out of either
# platform directory so the two copies cannot drift.
set(OPENBITFUN_ARGON2_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../../../../../../../shared/argon2)

# Build the pinned upstream C codec for the device ABI. No runtime download.
include(FetchContent)
FetchContent_Declare(zstd_source
  URL https://codeload.github.com/facebook/zstd/tar.gz/refs/tags/v1.5.7
  URL_HASH SHA256=37d7284556b20954e56e1ca85b80226768902e2edabd3b649e9e72c0c9012ee3)
FetchContent_GetProperties(zstd_source)
if(NOT zstd_source_POPULATED)
  FetchContent_Populate(zstd_source)
endif()
set(ZSTD_BUILD_PROGRAMS OFF CACHE BOOL "" FORCE)
set(ZSTD_BUILD_SHARED OFF CACHE BOOL "" FORCE)
set(ZSTD_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(ZSTD_MULTITHREAD_SUPPORT OFF CACHE BOOL "" FORCE)
add_subdirectory(${zstd_source_SOURCE_DIR}/build/cmake ${zstd_source_BINARY_DIR} EXCLUDE_FROM_ALL)

add_library(openbitfun_crypto SHARED
  relay_message_encoding.cpp
  napi_argon2.cpp
  ${OPENBITFUN_ARGON2_DIR}/argon2.c
  ${OPENBITFUN_ARGON2_DIR}/core.c
  ${OPENBITFUN_ARGON2_DIR}/encoding.c
  ${OPENBITFUN_ARGON2_DIR}/ref.c
  ${OPENBITFUN_ARGON2_DIR}/run.c
  ${OPENBITFUN_ARGON2_DIR}/thread.c
  ${OPENBITFUN_ARGON2_DIR}/blake2/blake2b.c
)

target_include_directories(openbitfun_crypto PRIVATE ${OPENBITFUN_ARGON2_DIR})
target_compile_definitions(openbitfun_crypto PRIVATE A2_VISCTL)
target_link_libraries(openbitfun_crypto PRIVATE libzstd_static libace_napi.z.so)
