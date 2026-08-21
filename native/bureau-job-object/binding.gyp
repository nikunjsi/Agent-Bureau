{
  "targets": [
    {
      "target_name": "bureau_job_object",
      "sources": ["src/binding.cc"],
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
      "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "NAPI_VERSION=8"],
      "conditions": [
        [
          "OS=='win'",
          {
            "libraries": []
          },
          {
            "sources": []
          }
        ]
      ]
    }
  ]
}
