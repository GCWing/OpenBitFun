#include <cstdint>
#include <cstring>
#include <memory>
#include <new>
#include <vector>
#include "napi/native_api.h"
#include "zstd.h"

namespace {
constexpr uint8_t PREFIX[] = {0xff, 'O', 'Z', 1};
constexpr size_t HEADER = 8;
constexpr size_t MAX_BYTES = 64 * 1024 * 1024;

struct RelayCodecWork {
    napi_async_work task = nullptr;
    napi_deferred deferred = nullptr;
    bool compress = false;
    std::vector<uint8_t> input;
    std::vector<uint8_t> output;
    const char *error = nullptr;
};

napi_value fail(napi_env env, const char *message) {
    napi_throw_error(env, nullptr, message);
    return nullptr;
}

void execute(napi_env, void *data) {
    auto *work = static_cast<RelayCodecWork *>(data);
    const auto &input = work->input;
    try {
        if (work->compress) {
            work->output.resize(ZSTD_compressBound(input.size()) + HEADER);
            const size_t size = ZSTD_compress(work->output.data() + HEADER,
                work->output.size() - HEADER, input.data(), input.size(), 1);
            if (ZSTD_isError(size)) {
                work->error = "Relay Zstd compression failed";
                return;
            }
            if (size + HEADER >= input.size()) {
                work->output = std::move(work->input);
                return;
            }
            std::memcpy(work->output.data(), PREFIX, sizeof(PREFIX));
            for (unsigned i = 0; i < 4; ++i) {
                work->output[4 + i] = static_cast<uint8_t>(input.size() >> (8 * i));
            }
            work->output.resize(size + HEADER);
            return;
        }
        if (input.size() <= HEADER || std::memcmp(input.data(), PREFIX, sizeof(PREFIX)) != 0) {
            work->error = "Unknown Relay message encoding";
            return;
        }
        uint32_t expected = 0;
        for (unsigned i = 0; i < 4; ++i) expected |= static_cast<uint32_t>(input[4 + i]) << (8 * i);
        if (!expected || expected > MAX_BYTES ||
            ZSTD_findFrameCompressedSize(input.data() + HEADER, input.size() - HEADER) != input.size() - HEADER) {
            work->error = "Invalid Relay Zstd frame";
            return;
        }
        work->output.resize(expected);
        if (ZSTD_decompress(work->output.data(), expected, input.data() + HEADER, input.size() - HEADER) != expected) {
            work->error = "Relay decoded size mismatch";
        }
    } catch (const std::bad_alloc &) {
        work->error = "Unable to allocate Relay codec buffer";
    }
}

void complete(napi_env env, napi_status status, void *data) {
    std::unique_ptr<RelayCodecWork> work(static_cast<RelayCodecWork *>(data));
    if (status != napi_ok) work->error = "Relay codec work failed";
    if (!work->error) {
        void *bytes = nullptr;
        napi_value storage, result;
        if (napi_create_arraybuffer(env, work->output.size(), &bytes, &storage) == napi_ok &&
            napi_create_typedarray(env, napi_uint8_array, work->output.size(), storage, 0, &result) == napi_ok) {
            std::memcpy(bytes, work->output.data(), work->output.size());
            napi_resolve_deferred(env, work->deferred, result);
        } else {
            work->error = "Unable to allocate Relay message";
        }
    }
    if (work->error) {
        napi_value message, error;
        napi_create_string_utf8(env, work->error, NAPI_AUTO_LENGTH, &message);
        napi_create_error(env, nullptr, message, &error);
        napi_reject_deferred(env, work->deferred, error);
    }
    napi_delete_async_work(env, work->task);
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
    const bool unchanged = compress ? length <= 256 || length > MAX_BYTES : length == 0 || src[0] != 0xff;
    napi_value promise;
    napi_deferred deferred;
    if (napi_create_promise(env, &deferred, &promise) != napi_ok) return fail(env, "Unable to create Relay codec promise");
    if (unchanged) {
        napi_resolve_deferred(env, deferred, arg);
        return promise;
    }
    auto work = std::unique_ptr<RelayCodecWork>(new (std::nothrow) RelayCodecWork());
    if (!work) return fail(env, "Unable to allocate Relay codec work");
    work->compress = compress;
    work->deferred = deferred;
    try {
        work->input.assign(src, src + length);
    } catch (const std::bad_alloc &) {
        return fail(env, "Unable to allocate Relay input");
    }
    napi_value resource;
    if (napi_create_string_utf8(env, "OpenBitFunRelayCodec", NAPI_AUTO_LENGTH, &resource) != napi_ok ||
        napi_create_async_work(env, nullptr, resource, execute, complete, work.get(), &work->task) != napi_ok) {
        return fail(env, "Unable to create Relay codec work");
    }
    if (napi_queue_async_work(env, work->task) != napi_ok) {
        napi_delete_async_work(env, work->task);
        return fail(env, "Unable to queue Relay codec work");
    }
    work.release();
    return promise;
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
