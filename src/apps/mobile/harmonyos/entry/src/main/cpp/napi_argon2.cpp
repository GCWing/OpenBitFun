#include <array>
#include <cstdint>
#include <cstring>
#include <new>
#include <vector>

#include "argon2.h"
#include "napi/native_api.h"

void defineRelayMessageEncoding(napi_env env, napi_value exports);

namespace {

constexpr size_t ARGON2_OUTPUT_LENGTH = 32;

struct Argon2Work {
    napi_async_work asyncWork = nullptr;
    napi_deferred deferred = nullptr;
    std::vector<uint8_t> password;
    std::vector<uint8_t> salt;
    uint32_t memory = 0;
    uint32_t time = 0;
    uint32_t lanes = 0;
    std::array<uint8_t, ARGON2_OUTPUT_LENGTH> output{};
    int result = ARGON2_OK;
};

void secureClear(uint8_t *data, size_t length) {
    volatile uint8_t *cursor = data;
    while (length > 0) {
        *cursor = 0;
        ++cursor;
        --length;
    }
}

void clearWorkSecrets(Argon2Work *work) {
    if (!work->password.empty()) {
        secureClear(work->password.data(), work->password.size());
    }
    secureClear(work->output.data(), work->output.size());
}

bool readBytes(napi_env env, napi_value value, const uint8_t **data, size_t *length) {
    bool isTypedArray = false;
    if (napi_is_typedarray(env, value, &isTypedArray) != napi_ok || !isTypedArray) {
        return false;
    }
    napi_typedarray_type type;
    size_t count = 0;
    void *raw = nullptr;
    napi_value arrayBuffer;
    size_t offset = 0;
    if (napi_get_typedarray_info(env, value, &type, &count, &raw, &arrayBuffer, &offset) != napi_ok ||
        type != napi_uint8_array || raw == nullptr) {
        return false;
    }
    *data = static_cast<const uint8_t *>(raw);
    *length = count;
    return true;
}

napi_value throwTypeError(napi_env env, const char *message) {
    napi_throw_type_error(env, nullptr, message);
    return nullptr;
}

napi_value throwError(napi_env env, const char *message) {
    napi_throw_error(env, nullptr, message);
    return nullptr;
}

void executeArgon2(napi_env, void *data) {
    auto *work = static_cast<Argon2Work *>(data);
    work->result = argon2id_hash_raw(
        work->time,
        work->memory,
        work->lanes,
        work->password.data(),
        work->password.size(),
        work->salt.data(),
        work->salt.size(),
        work->output.data(),
        work->output.size());
    if (!work->password.empty()) {
        secureClear(work->password.data(), work->password.size());
    }
}

void completeArgon2(napi_env env, napi_status status, void *data) {
    auto *work = static_cast<Argon2Work *>(data);
    if (status == napi_ok && work->result == ARGON2_OK) {
        napi_value resultBuffer = nullptr;
        void *resultData = nullptr;
        napi_value resultArray = nullptr;
        if (napi_create_arraybuffer(env, work->output.size(), &resultData, &resultBuffer) == napi_ok &&
            napi_create_typedarray(env, napi_uint8_array, work->output.size(), resultBuffer, 0, &resultArray) == napi_ok) {
            std::memcpy(resultData, work->output.data(), work->output.size());
            napi_resolve_deferred(env, work->deferred, resultArray);
        } else {
            napi_value message = nullptr;
            napi_value error = nullptr;
            napi_create_string_utf8(env, "Unable to allocate Argon2id result.", NAPI_AUTO_LENGTH, &message);
            napi_create_error(env, nullptr, message, &error);
            napi_reject_deferred(env, work->deferred, error);
        }
    } else {
        const char *reason = status == napi_cancelled ? "Argon2id operation was cancelled." :
            (work->result == ARGON2_OK ? "Argon2id operation failed." : argon2_error_message(work->result));
        napi_value message = nullptr;
        napi_value error = nullptr;
        napi_create_string_utf8(env, reason, NAPI_AUTO_LENGTH, &message);
        napi_create_error(env, nullptr, message, &error);
        napi_reject_deferred(env, work->deferred, error);
    }

    clearWorkSecrets(work);
    napi_delete_async_work(env, work->asyncWork);
    delete work;
}

napi_value argon2idRaw(napi_env env, napi_callback_info info) {
    size_t argc = 5;
    napi_value argv[5] = {nullptr};
    if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 5) {
        return throwTypeError(env, "argon2idRaw requires five arguments.");
    }

    const uint8_t *password = nullptr;
    const uint8_t *salt = nullptr;
    size_t passwordLength = 0;
    size_t saltLength = 0;
    if (!readBytes(env, argv[0], &password, &passwordLength) ||
        !readBytes(env, argv[1], &salt, &saltLength)) {
        return throwTypeError(env, "Argon2id password and salt must be Uint8Array values.");
    }

    uint32_t memory = 0;
    uint32_t time = 0;
    uint32_t lanes = 0;
    if (napi_get_value_uint32(env, argv[2], &memory) != napi_ok ||
        napi_get_value_uint32(env, argv[3], &time) != napi_ok ||
        napi_get_value_uint32(env, argv[4], &lanes) != napi_ok) {
        return throwTypeError(env, "Argon2id parameters must be unsigned integers.");
    }

    auto *work = new (std::nothrow) Argon2Work();
    if (work == nullptr) {
        return throwError(env, "Unable to allocate Argon2id work.");
    }
    work->password.assign(password, password + passwordLength);
    work->salt.assign(salt, salt + saltLength);
    work->memory = memory;
    work->time = time;
    work->lanes = lanes;

    napi_value promise = nullptr;
    if (napi_create_promise(env, &work->deferred, &promise) != napi_ok) {
        clearWorkSecrets(work);
        delete work;
        return throwError(env, "Unable to create Argon2id promise.");
    }

    napi_value resourceName = nullptr;
    if (napi_create_string_utf8(env, "OpenBitFunArgon2id", NAPI_AUTO_LENGTH, &resourceName) != napi_ok ||
        napi_create_async_work(env, nullptr, resourceName, executeArgon2, completeArgon2, work,
            &work->asyncWork) != napi_ok) {
        clearWorkSecrets(work);
        delete work;
        return throwError(env, "Unable to create Argon2id async work.");
    }
    if (napi_queue_async_work(env, work->asyncWork) != napi_ok) {
        napi_delete_async_work(env, work->asyncWork);
        clearWorkSecrets(work);
        delete work;
        return throwError(env, "Unable to queue Argon2id async work.");
    }
    return promise;
}

napi_value init(napi_env env, napi_value exports) {
    napi_property_descriptor descriptor = {
        "argon2idRaw", nullptr, argon2idRaw, nullptr, nullptr, nullptr, napi_default, nullptr};
    napi_define_properties(env, exports, 1, &descriptor);
    defineRelayMessageEncoding(env, exports);
    return exports;
}

}  // namespace

EXTERN_C_START
static napi_module module = {
    .nm_version = 1,
    .nm_flags = 0,
    .nm_filename = nullptr,
    .nm_register_func = init,
    .nm_modname = "openbitfun_crypto",
    .nm_priv = nullptr,
    .reserved = {0},
};
EXTERN_C_END

extern "C" __attribute__((constructor)) void RegisterOpenBitFunCrypto(void) {
    napi_module_register(&module);
}
