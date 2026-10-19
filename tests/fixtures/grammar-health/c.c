#include <stdio.h>
#include <stdlib.h>

typedef struct node {
	int value;
	struct node *next;
} node_t;

static node_t *push(node_t *head, int value) {
	node_t *n = malloc(sizeof *n);
	if (n == NULL) {
		return head;
	}
	n->value = value;
	n->next = head;
	return n;
}

int main(int argc, char **argv) {
	node_t *list = NULL;
	for (int i = 0; i < argc; i++) {
		list = push(list, (int)strtol(argv[i], NULL, 10));
	}
	while (list != NULL) {
		printf("%d\n", list->value);
		list = list->next;
	}
	return 0;
}
