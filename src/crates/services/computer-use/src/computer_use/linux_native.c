// Optional Linux capture/OCR libraries are loaded only when used. Linking this
// shim must not make a headless CLI depend on a desktop's installed libraries.
// Compile against the vendor C headers so function signatures and layouts are
// checked by the compiler; retain library handles for the process lifetime.
#include <dlfcn.h>
#include <gst/app/gstappsink.h>
#include <gst/gst.h>
#include <leptonica/allheaders.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <tesseract/capi.h>

#define DECLARE(name) __typeof__(&name) name
#define LOAD(table, library, name)                                                                 \
  do {                                                                                             \
    *(void **)(&table.name) = dlsym(library, #name);                                               \
    if (!table.name) {                                                                             \
      snprintf(table.error, sizeof(table.error), "Missing native symbol %s", #name);               \
      return;                                                                                      \
    }                                                                                              \
  } while (0)

static struct {
  char error[256];
  DECLARE(gst_init_check);
  DECLARE(gst_element_factory_find);
  DECLARE(gst_parse_launch);
  DECLARE(gst_bin_get_by_name);
  DECLARE(gst_element_set_state);
  DECLARE(gst_element_get_bus);
  DECLARE(gst_bus_pop_filtered);
  DECLARE(gst_mini_object_unref);
  DECLARE(gst_app_sink_try_pull_sample);
  DECLARE(gst_sample_get_buffer);
  DECLARE(gst_sample_get_caps);
  DECLARE(gst_caps_get_structure);
  DECLARE(gst_structure_get_int);
  DECLARE(gst_buffer_map);
  DECLARE(gst_buffer_unmap);
  DECLARE(g_object_get);
  DECLARE(g_object_set);
  DECLARE(g_object_unref);
  DECLARE(g_object_class_find_property);
  DECLARE(g_error_free);
} gst;
static pthread_once_t gst_once = PTHREAD_ONCE_INIT;

static void load_gst(void) {
  void *core = dlopen("libgstreamer-1.0.so.0", RTLD_NOW | RTLD_LOCAL);
  void *app = dlopen("libgstapp-1.0.so.0", RTLD_NOW | RTLD_LOCAL);
  void *object = dlopen("libgobject-2.0.so.0", RTLD_NOW | RTLD_LOCAL);
  void *glib = dlopen("libglib-2.0.so.0", RTLD_NOW | RTLD_LOCAL);
  if (!core || !app || !object || !glib) {
    snprintf(
        gst.error, sizeof(gst.error),
        "GStreamer is unavailable; install the GStreamer runtime, PipeWire and base/good plugins");
    return;
  }
  LOAD(gst, core, gst_init_check);
  LOAD(gst, core, gst_element_factory_find);
  LOAD(gst, core, gst_parse_launch);
  LOAD(gst, core, gst_bin_get_by_name);
  LOAD(gst, core, gst_element_set_state);
  LOAD(gst, core, gst_element_get_bus);
  LOAD(gst, core, gst_bus_pop_filtered);
  LOAD(gst, core, gst_mini_object_unref);
  LOAD(gst, app, gst_app_sink_try_pull_sample);
  LOAD(gst, core, gst_sample_get_buffer);
  LOAD(gst, core, gst_sample_get_caps);
  LOAD(gst, core, gst_caps_get_structure);
  LOAD(gst, core, gst_structure_get_int);
  LOAD(gst, core, gst_buffer_map);
  LOAD(gst, core, gst_buffer_unmap);
  LOAD(gst, object, g_object_get);
  LOAD(gst, object, g_object_set);
  LOAD(gst, object, g_object_unref);
  LOAD(gst, object, g_object_class_find_property);
  LOAD(gst, glib, g_error_free);
}

int obf_gst_init(char *error, size_t size) {
  pthread_once(&gst_once, load_gst);
  if (gst.error[0]) {
    snprintf(error, size, "%s", gst.error);
    return 0;
  }
  GError *failure = NULL;
  if (!gst.gst_init_check(NULL, NULL, &failure)) {
    snprintf(error, size, "%s", failure ? failure->message : "GStreamer initialization failed");
    if (failure)
      gst.g_error_free(failure);
    return 0;
  }
  return 1;
}
int obf_gst_has_factory(const char *name) {
  GstElementFactory *factory = gst.gst_element_factory_find(name);
  if (!factory)
    return 0;
  gst.g_object_unref(factory);
  return 1;
}

typedef struct {
  GstElement *pipeline;
  GstElement *sink;
  GstBus *bus;
} ObfPipeline;
void obf_gst_release(ObfPipeline *state) {
  if (!state)
    return;
  gst.gst_element_set_state(state->pipeline, GST_STATE_NULL);
  if (state->sink)
    gst.g_object_unref(state->sink);
  if (state->bus)
    gst.g_object_unref(state->bus);
  gst.g_object_unref(state->pipeline);
  free(state);
}
ObfPipeline *obf_gst_start(const char *description, const char *serial, char *error, size_t size) {
  if (!obf_gst_init(error, size))
    return NULL;
  GError *failure = NULL;
  GstElement *pipeline = gst.gst_parse_launch(description, &failure);
  if (!pipeline || failure) {
    snprintf(error, size, "%s", failure ? failure->message : "No GStreamer pipeline");
    if (failure)
      gst.g_error_free(failure);
    if (pipeline)
      gst.g_object_unref(pipeline);
    return NULL;
  }
  ObfPipeline *state = calloc(1, sizeof(*state));
  if (!state) {
    gst.g_object_unref(pipeline);
    snprintf(error, size, "Out of memory");
    return NULL;
  }
  state->pipeline = pipeline;
  state->sink = gst.gst_bin_get_by_name((GstBin *)pipeline, "frames");
  state->bus = gst.gst_element_get_bus(pipeline);
  if (!state->sink || !state->bus) {
    snprintf(error, size, "Missing frame sink or bus");
    goto fail;
  }
  if (serial) {
    GstElement *source = gst.gst_bin_get_by_name((GstBin *)pipeline, "portal");
    if (!source) {
      snprintf(error, size, "Missing PipeWire source");
      goto fail;
    }
    if (!gst.g_object_class_find_property((GObjectClass *)((GTypeInstance *)source)->g_class,
                                          "target-object")) {
      gst.g_object_unref(source);
      snprintf(error, size,
               "PipeWire plugin cannot target stable portal stream identities; upgrade "
               "gstreamer1.0-pipewire");
      goto fail;
    }
    gst.g_object_set(source, "path", NULL, "target-object", serial, NULL);
    gst.g_object_unref(source);
  }
  if (gst.gst_element_set_state(pipeline, GST_STATE_PLAYING) == GST_STATE_CHANGE_FAILURE) {
    snprintf(error, size, "Cannot start PipeWire stream");
    goto fail;
  }
  return state;
fail:
  obf_gst_release(state);
  return NULL;
}
int obf_gst_stop(ObfPipeline *state) {
  return gst.gst_element_set_state(state->pipeline, GST_STATE_NULL) != GST_STATE_CHANGE_FAILURE;
}
int obf_gst_ended(ObfPipeline *state) {
  GstMessage *message = gst.gst_bus_pop_filtered(state->bus, GST_MESSAGE_ERROR | GST_MESSAGE_EOS);
  if (!message)
    return 0;
  gst.gst_mini_object_unref((GstMiniObject *)message);
  return 1;
}
// 1 = frame, 0 = no sample, -1 = invalid sample. The caller owns returned bytes.
int obf_gst_frame(ObfPipeline *state, uint64_t timeout, int last, unsigned char **bytes,
                  size_t *length, int *width, int *height, char *error, size_t error_size) {
  *bytes = NULL;
  *length = 0;
  GstSample *sample = NULL;
  if (last)
    gst.g_object_get(state->sink, "last-sample", &sample, NULL);
  else
    sample = gst.gst_app_sink_try_pull_sample((GstAppSink *)state->sink, timeout);
  if (!sample)
    return 0;
  int result = -1;
  GstCaps *caps = gst.gst_sample_get_caps(sample);
  const GstStructure *geometry = caps ? gst.gst_caps_get_structure(caps, 0) : NULL;
  if (!geometry || !gst.gst_structure_get_int(geometry, "width", width) ||
      !gst.gst_structure_get_int(geometry, "height", height) || *width <= 0 || *height <= 0) {
    snprintf(error, error_size, "Missing or invalid PipeWire frame dimensions");
    goto done;
  }
  GstBuffer *buffer = gst.gst_sample_get_buffer(sample);
  GstMapInfo map = GST_MAP_INFO_INIT;
  if (!buffer || !gst.gst_buffer_map(buffer, &map, GST_MAP_READ)) {
    snprintf(error, error_size, "Cannot map PipeWire frame");
    goto done;
  }
  // Match the bounded native screenshot contract and avoid unbounded copies.
  if (map.size == 0 || map.size > 64 * 1024 * 1024) {
    snprintf(error, error_size, "Empty or oversized PipeWire frame");
  } else {
    *bytes = malloc(map.size);
    if (*bytes) {
      memcpy(*bytes, map.data, map.size);
      *length = map.size;
      result = 1;
    } else
      snprintf(error, error_size, "Out of memory");
  }
  gst.gst_buffer_unmap(buffer, &map);
done:
  gst.gst_mini_object_unref((GstMiniObject *)sample);
  return result;
}
void obf_native_free(void *bytes) { free(bytes); }

static struct {
  char error[256];
  DECLARE(TessBaseAPICreate);
  DECLARE(TessBaseAPIInit3);
  DECLARE(TessBaseAPISetImage2);
  DECLARE(TessBaseAPIRecognize);
  DECLARE(TessBaseAPIGetTsvText);
  DECLARE(TessBaseAPIDelete);
  DECLARE(TessBaseAPIGetComponentImages);
  DECLARE(TessBaseAPISetRectangle);
  DECLARE(TessBaseAPIGetUTF8Text);
  DECLARE(TessBaseAPIMeanTextConf);
  DECLARE(TessDeleteText);
  DECLARE(pixReadMem);
  DECLARE(pixDestroy);
  DECLARE(boxaGetCount);
  DECLARE(boxaGetBoxGeometry);
  DECLARE(boxaDestroy);
} tess;
static pthread_once_t tess_once = PTHREAD_ONCE_INIT;
static void load_tess(void) {
  void *api = dlopen("libtesseract.so.5", RTLD_NOW | RTLD_LOCAL);
  if (!api)
    api = dlopen("libtesseract.so.4", RTLD_NOW | RTLD_LOCAL);
  void *lept = dlopen("liblept.so.5", RTLD_NOW | RTLD_LOCAL);
  if (!api || !lept) {
    snprintf(tess.error, sizeof(tess.error),
             "Tesseract is unavailable; install tesseract-ocr and tesseract-ocr-eng");
    return;
  }
  LOAD(tess, api, TessBaseAPICreate);
  LOAD(tess, api, TessBaseAPIInit3);
  LOAD(tess, api, TessBaseAPISetImage2);
  LOAD(tess, api, TessBaseAPIRecognize);
  LOAD(tess, api, TessBaseAPIGetTsvText);
  LOAD(tess, api, TessBaseAPIDelete);
  LOAD(tess, api, TessBaseAPIGetComponentImages);
  LOAD(tess, api, TessBaseAPISetRectangle);
  LOAD(tess, api, TessBaseAPIGetUTF8Text);
  LOAD(tess, api, TessBaseAPIMeanTextConf);
  LOAD(tess, api, TessDeleteText);
  LOAD(tess, lept, pixReadMem);
  LOAD(tess, lept, pixDestroy);
  LOAD(tess, lept, boxaGetCount);
  LOAD(tess, lept, boxaGetBoxGeometry);
  LOAD(tess, lept, boxaDestroy);
}
typedef struct {
  char *text;
  int x, y, width, height, confidence;
} ObfOcrWord;
typedef struct {
  char *tsv;
  ObfOcrWord *words;
  size_t count;
} ObfOcr;
void obf_tess_release(ObfOcr *result) {
  if (!result)
    return;
  free(result->tsv);
  for (size_t i = 0; i < result->count; ++i)
    free(result->words[i].text);
  free(result->words);
  free(result);
}
ObfOcr *obf_tess_read(const unsigned char *image, size_t length, int words, char *error,
                      size_t size) {
  pthread_once(&tess_once, load_tess);
  if (tess.error[0]) {
    snprintf(error, size, "%s", tess.error);
    return NULL;
  }
  TessBaseAPI *api = tess.TessBaseAPICreate();
  if (!api) {
    snprintf(error, size, "Tesseract allocation failed");
    return NULL;
  }
  PIX *pix = NULL;
  BOXA *boxes = NULL;
  ObfOcr *result = NULL;
  // Preserve TESSDATA_PREFIX and the existing system-path fallback.
  const char *paths[] = {NULL, "/usr/share/tesseract-ocr/5/tessdata/",
                         "/usr/share/tesseract-ocr/tessdata/", "/usr/share/tessdata/"};
  int initialized = 0;
  for (size_t i = 0; i < sizeof(paths) / sizeof(paths[0]); ++i)
    if (tess.TessBaseAPIInit3(api, paths[i], "eng") == 0) {
      initialized = 1;
      break;
    }
  if (!initialized) {
    snprintf(
        error, size,
        "Tesseract initialization failed; install tesseract-ocr-eng or configure TESSDATA_PREFIX");
    goto done;
  }
  pix = tess.pixReadMem(image, length);
  if (!pix) {
    snprintf(error, size, "Leptonica could not decode the screenshot");
    goto done;
  }
  tess.TessBaseAPISetImage2(api, pix);
  if (tess.TessBaseAPIRecognize(api, NULL) != 0) {
    snprintf(error, size, "Tesseract recognition failed");
    goto done;
  }
  result = calloc(1, sizeof(*result));
  if (!result) {
    snprintf(error, size, "Out of memory");
    goto done;
  }
  if (!words) {
    char *tsv = tess.TessBaseAPIGetTsvText(api, 0);
    if (tsv) {
      result->tsv = strdup(tsv);
      tess.TessDeleteText(tsv);
    }
    if (!result->tsv) {
      snprintf(error, size, "Tesseract returned no TSV text");
      goto failed;
    }
  } else {
    boxes = tess.TessBaseAPIGetComponentImages(api, RIL_WORD, TRUE, NULL, NULL);
    if (!boxes) {
      snprintf(error, size, "Tesseract returned no word regions");
      goto failed;
    }
    int count = tess.boxaGetCount(boxes);
    if (count < 0 || count > 100000) {
      snprintf(error, size, "Invalid word region count");
      goto failed;
    }
    result->words = calloc((size_t)count + 1, sizeof(ObfOcrWord));
    if (!result->words) {
      snprintf(error, size, "Out of memory");
      goto failed;
    }
    result->count = (size_t)count;
    for (int i = 0; i < count; ++i) {
      ObfOcrWord *word = &result->words[i];
      if (tess.boxaGetBoxGeometry(boxes, i, &word->x, &word->y, &word->width, &word->height) != 0 ||
          word->width <= 0 || word->height <= 0)
        continue;
      tess.TessBaseAPISetRectangle(api, word->x, word->y, word->width, word->height);
      char *text = tess.TessBaseAPIGetUTF8Text(api);
      if (!text)
        continue;
      word->text = strdup(text);
      tess.TessDeleteText(text);
      word->confidence = tess.TessBaseAPIMeanTextConf(api);
      if (!word->text) {
        snprintf(error, size, "Out of memory");
        goto failed;
      }
    }
  }
  goto done;
failed:
  obf_tess_release(result);
  result = NULL;
done:
  if (boxes)
    tess.boxaDestroy(&boxes);
  tess.TessBaseAPIDelete(api);
  if (pix)
    tess.pixDestroy(&pix);
  return result;
}
