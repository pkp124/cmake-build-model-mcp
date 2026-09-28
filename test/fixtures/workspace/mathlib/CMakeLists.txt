cmake_minimum_required(VERSION 3.16)
project(MathLib LANGUAGES C)

add_library(mathc src/mathc.c)
target_include_directories(mathc PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src)

add_executable(calc src/calc.c)
target_link_libraries(calc PRIVATE mathc)
