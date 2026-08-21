// Windows Job Object process containment (BUILD-SPEC.md §4.4).
//
// Bureau spawns agent CLIs as child processes. If Bureau itself is killed
// (crash, Ctrl+Alt+Del, task manager), those children must not survive as
// orphans burning tokens. A Windows Job Object with
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE does this at the OS level: when the
// last handle to the job closes (which happens automatically when the
// Bureau process dies, for any reason, including a hard kill), Windows
// terminates every process still assigned to the job.
//
// This addon exposes exactly two functions to JS:
//   initJob()            — create the job object once, set the kill-on-close
//                           limit. Idempotent; safe to call more than once.
//   assignProcess(pid)   — assign an existing process (by PID) to the job.
//                           Job membership propagates to that process's own
//                           future children, so this only needs to be called
//                           once per top-level spawned process.

#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <string>

#include <napi.h>

namespace {

HANDLE g_job = nullptr;

}  // namespace

// initJob(): boolean
Napi::Value InitJob(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (g_job != nullptr) {
    return Napi::Boolean::New(env, true);
  }

  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (job == nullptr) {
    Napi::Error::New(env, "CreateJobObjectW failed with error " + std::to_string(GetLastError()))
        .ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

  BOOL ok = SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits,
                                     sizeof(limits));
  if (!ok) {
    DWORD lastError = GetLastError();
    CloseHandle(job);
    Napi::Error::New(env, "SetInformationJobObject failed with error " +
                              std::to_string(lastError))
        .ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  g_job = job;
  return Napi::Boolean::New(env, true);
}

// assignProcess(pid: number): boolean
Napi::Value AssignProcess(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (g_job == nullptr) {
    Napi::Error::New(env, "assignProcess called before initJob").ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "assignProcess expects a numeric pid").ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  DWORD pid = static_cast<DWORD>(info[0].As<Napi::Number>().Uint32Value());

  HANDLE process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, FALSE, pid);
  if (process == nullptr) {
    Napi::Error::New(env, "OpenProcess failed for pid " + std::to_string(pid) +
                              " with error " + std::to_string(GetLastError()))
        .ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  BOOL ok = AssignProcessToJobObject(g_job, process);
  DWORD lastError = ok ? 0 : GetLastError();
  CloseHandle(process);

  if (!ok) {
    Napi::Error::New(env, "AssignProcessToJobObject failed for pid " + std::to_string(pid) +
                              " with error " + std::to_string(lastError))
        .ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  return Napi::Boolean::New(env, true);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set(Napi::String::New(env, "initJob"), Napi::Function::New(env, InitJob));
  exports.Set(Napi::String::New(env, "assignProcess"), Napi::Function::New(env, AssignProcess));
  return exports;
}

NODE_API_MODULE(bureau_job_object, Init)
