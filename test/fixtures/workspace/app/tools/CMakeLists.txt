add_executable(app_cli main.cpp)
target_link_libraries(app_cli PRIVATE core)
target_compile_options(app_cli PRIVATE -Wall)

add_test(NAME app.tool COMMAND ${CMAKE_COMMAND} -E echo tool)
set_tests_properties(app.tool PROPERTIES LABELS cli)
