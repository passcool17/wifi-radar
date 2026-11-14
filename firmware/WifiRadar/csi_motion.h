#pragma once
#include <Arduino.h>

struct RadarReading {
  int64_t t;
  float rssi;
  float motion;
  bool presence;
};

void csiMotionBegin();
void csiMotionEnd();
void csiMotionStartTraffic();
RadarReading csiMotionRead();
bool csiMotionHasFrame();
