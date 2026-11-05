#include <cstdint>
#include <cstring>
#include <memory>
#include <new>
#include "napi/native_api.h"
#include "zstd.h"

namespace {
constexpr uint8_t PREFIX[] = {0xff, 'O', 'Z', 1};
constexpr size_t HEADER = 8;
constexpr size_t MAX_BYTES = 64 * 1024 * 1024;

napi_value fail(napi_env env, const char *message) {
    napi_throw_error(env, nullptr, message);
    return nullptr;
}

napi_value buffer(napi_env env, size_t length, uint8_t **bytes) {
    void *data = nullptr;
    napi_value storage, result;
    if (napi_create_arraybuffer(env, length, &data, &storage) != napi_ok ||
        napi_create_typedarray(env, napi_uint8_array, length, storage, 0, &result) != napi_ok) {
        return fail(env, "Unable to allocate Relay message");
    }
    *bytes = static_cast<uint8_t *>(data);
    return result;
}

napi_value transform(napi_env env, napi_callback_info info, bool compress) {
    size_t argc = 1, length = 0, offset = 0;
    napi_value arg, storage;
    napi_typedarray_type type;
    void *data = nullptr;
    if (napi_get_cb_info(env, info, &argc, &arg, nullptr, nullptr) != napi_ok || argc != 1 ||
        napi_get_typedarray_info(env, arg, &type, &length, &data, &storage, &offset) != napi_ok ||
        type != napi_uint8_array) return fail(env, "Expected Relay message bytes");
    auto *src = static_cast<const uint8_t *>(data);
    if (compress) {
        if (length <= 256 || length > MAX_BYTES) return arg;
        const size_t bound = ZSTD_compressBound(length);
        std::unique_ptr<uint8_t[]> tmp(new (std::nothrow) uint8_t[bound]);
        if (!tmp) return fail(env, "Unable to allocate Relay compression buffer");
        const size_t size = ZSTD_compress(tmp.get(), bound, src, length, 1);
        if (ZSTD_isError(size)) return fail(env, "Relay Zstd compression failed");
        if (size + HEADER >= length) return arg;
        uint8_t *out = nullptr;
        napi_value result = buffer(env, size + HEADER, &out);
        if (!result) return nullptr;
        std::memcpy(out, PREFIX, sizeof(PREFIX));
        for (unsigned i = 0; i < 4; ++i) out[4+i] = static_cast<uint8_t>(length >> (8*i));
        std::memcpy(out + HEADER, tmp.get(), size);
        return result;
    }
    if (length == 0 || src[0] != 0xff) return arg;
    if (length <= HEADER || std::memcmp(src, PREFIX, sizeof(PREFIX)) != 0)
        return fail(env, "Unknown Relay message encoding");
    uint32_t expected = 0;
    for (unsigned i = 0; i < 4; ++i) expected |= static_cast<uint32_t>(src[4+i]) << (8*i);
    if (!expected || expected > MAX_BYTES ||
        ZSTD_findFrameCompressedSize(src + HEADER, length - HEADER) != length - HEADER)
        return fail(env, "Invalid Relay Zstd frame");
    uint8_t *out = nullptr;
    napi_value result = buffer(env, expected, &out);
    if (!result) return nullptr;
    if (ZSTD_decompress(out, expected, src + HEADER, length - HEADER) != expected)
        return fail(env, "Relay decoded size mismatch");
    return result;
}
napi_value encode(napi_env env, napi_callback_info info) { return transform(env, info, true); }
napi_value decode(napi_env env, napi_callback_info info) { return transform(env, info, false); }
}

void defineRelayMessageEncoding(napi_env env, napi_value exports) {
    napi_property_descriptor methods[] = {
        {"encodeRelayMessage", nullptr, encode, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"decodeRelayMessage", nullptr, decode, nullptr, nullptr, nullptr, napi_default, nullptr},
    };
    napi_define_properties(env, exports, 2, methods);
}
