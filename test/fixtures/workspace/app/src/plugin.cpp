#include "core/core.hpp"

extern "C" int plugin_entry() { return core::answer(); }
