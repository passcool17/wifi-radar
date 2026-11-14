#pragma once
#include <Arduino.h>

void httpWsBegin();
void httpWsLoop();
void httpWsBroadcast(const char *json);
void httpWsSetSetupMode(bool setup);
bool httpWsIsSetupMode();
int httpWsClientCount();
