cmake_minimum_required(VERSION 3.16)
project(App VERSION 1.2.3 LANGUAGES CXX)

add_library(core STATIC src/core.cpp)
target_include_directories(core PUBLIC include)
target_compile_definitions(core PUBLIC CORE_VERSION=3 PRIVATE CORE_INTERNAL)
target_compile_features(core PUBLIC cxx_std_20)

# INTERFACE libraries only appear in the File API codemodel when they have sources.
add_library(headers_only INTERFACE headers/util.hpp)
target_include_directories(headers_only INTERFACE headers)

add_library(plugin SHARED src/plugin.cpp)
target_link_libraries(plugin PRIVATE core headers_only)

add_custom_target(docs COMMAND ${CMAKE_COMMAND} -E echo "docs")

add_subdirectory(tools)

install(TARGETS app_cli core DESTINATION bin)
