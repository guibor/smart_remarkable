/* No-writing input-discovery probe. Copies the marker's advertised input
 * capabilities, creates a temporary virtual device, and emits ZERO events.
 * No service restart, pen grab, notebook access or permanent file changes. */
#include <linux/input.h>
#include <linux/uinput.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <sys/ioctl.h>
#include <stdlib.h>
#define NBITS(n) (((n)+7)/8)
static int bit(const unsigned char *p, int i) { return (p[i/8] >> (i%8)) & 1; }
#define CHECK(x) do { if ((x)<0) { perror(#x); goto out; } } while(0)
int main(void) {
    int physical=-1, output=-1, created=0, result=1;
    char name[128]={0};
    unsigned char keys[NBITS(KEY_CNT)]={0}, axes[NBITS(ABS_CNT)]={0};
    unsigned char props[NBITS(INPUT_PROP_CNT)]={0}, misc[NBITS(MSC_CNT)]={0};
    struct input_id identity={0};
    CHECK(physical=open("/dev/input/event2",O_RDONLY|O_CLOEXEC));
    CHECK(ioctl(physical,EVIOCGNAME(sizeof(name)),name));
    if(strcmp(name,"Elan marker input")) { fputs("Unexpected marker\n",stderr); goto out; }
    CHECK(ioctl(physical,EVIOCGID,&identity));
    CHECK(ioctl(physical,EVIOCGBIT(EV_KEY,sizeof(keys)),keys));
    CHECK(ioctl(physical,EVIOCGBIT(EV_ABS,sizeof(axes)),axes));
    CHECK(ioctl(physical,EVIOCGBIT(EV_MSC,sizeof(misc)),misc));
    CHECK(ioctl(physical,EVIOCGPROP(sizeof(props)),props));
    CHECK(output=open("/dev/uinput",O_WRONLY|O_CLOEXEC));
    CHECK(ioctl(output,UI_SET_EVBIT,EV_KEY));
    CHECK(ioctl(output,UI_SET_EVBIT,EV_ABS));
    for(int i=0;i<KEY_CNT;i++) if(bit(keys,i)) CHECK(ioctl(output,UI_SET_KEYBIT,i));
    for(int i=0;i<INPUT_PROP_CNT;i++) if(bit(props,i)) CHECK(ioctl(output,UI_SET_PROPBIT,i));
    for(int i=0;i<MSC_CNT;i++) if(bit(misc,i)) {
        CHECK(ioctl(output,UI_SET_EVBIT,EV_MSC));
        CHECK(ioctl(output,UI_SET_MSCBIT,i));
    }
    for(int i=0;i<ABS_CNT;i++) if(bit(axes,i)) {
        struct uinput_abs_setup setup={.code=i};
        CHECK(ioctl(physical,EVIOCGABS(i),&setup.absinfo));
        CHECK(ioctl(output,UI_SET_ABSBIT,i));
        CHECK(ioctl(output,UI_ABS_SETUP,&setup));
    }
    struct uinput_setup setup={.id=identity};
    snprintf(setup.name,sizeof(setup.name),"Smart Dot capability probe");
    CHECK(ioctl(output,UI_DEV_SETUP,&setup));
    CHECK(ioctl(output,UI_DEV_CREATE)); created=1;
    char sysname[128]={0};
    CHECK(ioctl(output,UI_GET_SYSNAME(sizeof(sysname)),sysname));
    printf("Created %s with full marker capabilities; ZERO events emitted\n",sysname);
    fflush(stdout);
    sleep(20);
    result=0;
out:
    if(created) ioctl(output,UI_DEV_DESTROY);
    if(output>=0) close(output);
    if(physical>=0) close(physical);
    return result;
}
