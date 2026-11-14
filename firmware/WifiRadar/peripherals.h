#pragma once
#include <Arduino.h>

void peripheralsBegin();
void peripheralsLoop(float motion, bool presence, bool setupMode);
void peripheralsSetMute(bool mute);
bool peripheralsMuted();
bool peripheralsPir();
bool peripheralsConfirmed(bool presence);

