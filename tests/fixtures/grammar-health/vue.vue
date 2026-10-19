<script setup lang="ts">
import { computed, ref } from "vue";

const props = defineProps<{ label: string }>();
const count = ref(0);
const doubled = computed(() => count.value * 2);
</script>

<template>
  <section class="counter">
    <h2 v-if="props.label">{{ props.label }}</h2>
    <button type="button" @click="count++">Count: {{ count }}</button>
    <ul>
      <li v-for="n in 3" :key="n">{{ n * doubled }}</li>
    </ul>
  </section>
</template>

<style scoped>
.counter { display: flex; }
</style>
