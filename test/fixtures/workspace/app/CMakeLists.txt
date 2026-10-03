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

enable_testing()
add_subdirectory(tools)
set_property(DIRECTORY PROPERTY LABELS app)
add_test(NAME app.pass COMMAND ${CMAKE_COMMAND} -E echo pass)
set_tests_properties(app.pass PROPERTIES PASS_REGULAR_EXPRESSION "^pass" LABELS "unit;fast" TIMEOUT 15)
add_test(NAME app.broken COMMAND ${CMAKE_COMMAND} -E false)
set_tests_properties(app.broken PROPERTIES LABELS slow)
add_test(NAME app.expected_fail COMMAND ${CMAKE_COMMAND} -E false)
set_tests_properties(app.expected_fail PROPERTIES WILL_FAIL TRUE)
add_test(NAME app.setup COMMAND ${CMAKE_COMMAND} -E echo setup)
add_test(NAME app.cleanup COMMAND ${CMAKE_COMMAND} -E echo cleanup)
add_test(NAME app.needs COMMAND ${CMAKE_COMMAND} -E echo needs)
set_tests_properties(app.setup PROPERTIES FIXTURES_SETUP db LABELS setup)
set_tests_properties(app.cleanup PROPERTIES FIXTURES_CLEANUP db)
set_tests_properties(app.needs PROPERTIES FIXTURES_REQUIRED db DEPENDS app.pass LABELS unit)
add_test(NAME app.disabled COMMAND ${CMAKE_COMMAND} -E true)
set_tests_properties(app.disabled PROPERTIES DISABLED TRUE LABELS unit)

install(TARGETS app_cli core DESTINATION bin)
