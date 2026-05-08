/**
 * Catalog domain types — exposed as a named interface so consumers
 * (currently {@code job}) can hold {@code Flow} / {@code Agent} /
 * {@code Skill} / {@code Product} references returned by
 * {@code catalog.service} APIs.
 */
@org.springframework.modulith.NamedInterface("domain")
package com.jefelabs.agentx.controlplane.catalog.domain;
